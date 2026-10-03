// Phantom lines: the proposed editorInsets API inserts a webview between two lines of code to draw the
// removed lines on a red background, colored with the active theme. When the API is unavailable
// (no --enable-proposed-api, or the API changed), the hover fallback in decorations.ts takes over.
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { Hunk } from '../core/diff';
import type { PendingFile } from '../core/model';
import { hash53, plural } from '../core/text';
import type { StyledSpan } from '../core/textmate';

const MAX_LINES_PER_INSET = 400;

/** Syntax highlighting (SyntaxHighlighter in ui/highlight.ts) */
export interface Highlighting {
  peek(docKey: string, hash: string, languageId: string, lines: readonly string[], from: number, count: number): StyledSpan[][] | undefined;
  highlight(docKey: string, hash: string, languageId: string, lines: readonly string[], from: number, count: number): Promise<StyledSpan[][] | undefined>;
}

interface Entry {
  inset: vscode.WebviewEditorInset;
  /** The inset sits below this line (0-based); shifted like Monaco shifts view zones when the document changes */
  line: number;
  height: number;
  sig: string;
  dirty: boolean;
  /** The webview script is running and can receive messages */
  ready: boolean;
  /** Colors computed asynchronously but not yet sent to the webview */
  pendingTokens?: StyledSpan[][];
  disposed: boolean;
}

interface Wanted {
  hunk: Hunk;
  line: number;
  lines: string[];
  /** Number of lines to color (when truncated, the last line is the "N more lines" note) */
  code: number;
  sig: string;
}

export interface InsetAction {
  path: string;
  hunkId: string;
  action: 'keep' | 'undo' | 'ask';
  editor: vscode.TextEditor;
}

export interface InsetMetrics {
  insetPx: number;
  lines: number;
  linePx: number;
  fontFamily: string;
  fontSize: string;
}

export class PhantomInsets implements vscode.Disposable {
  private available: boolean;
  private readonly byEditor = new Map<vscode.TextEditor, Map<string, Entry>>();
  private readonly unavailableEmitter = new vscode.EventEmitter<void>();
  readonly onDidBecomeUnavailable = this.unavailableEmitter.event;
  readonly metrics: InsetMetrics[] = [];
  /** Number of colored spans each inset reports after highlighting (for tests and debugging) */
  readonly highlighted: number[] = [];
  highlighting: Highlighting | undefined;
  /** Show the "Ask Claude" button when the Claude Code extension is installed */
  askEnabled = false;

  constructor(
    extension: vscode.Extension<unknown>,
    private readonly onAction: (a: InsetAction) => void,
    private readonly log: (msg: string) => void,
  ) {
    const proposals: unknown = (extension.packageJSON as { enabledApiProposals?: unknown }).enabledApiProposals;
    this.available =
      typeof (vscode.window as { createWebviewTextEditorInset?: unknown }).createWebviewTextEditorInset === 'function' &&
      Array.isArray(proposals) &&
      proposals.includes('editorInsets');
    if (!this.available) this.log('editorInsets unavailable; removed lines are shown in hovers (needs --enable-proposed-api local.cc-review)');
  }

  get isAvailable(): boolean {
    return this.available;
  }

  get insetCount(): number {
    let n = 0;
    for (const m of this.byEditor.values()) n += m.size;
    return n;
  }

  /** Editors that are no longer visible: their insets died with them, so drop the records */
  retainEditors(visible: readonly vscode.TextEditor[]): void {
    const keep = new Set(visible);
    for (const [ed, entries] of this.byEditor) {
      if (keep.has(ed)) continue;
      for (const e of entries.values()) e.inset.dispose();
      this.byEditor.delete(ed);
    }
  }

  /**
   * Shift the recorded anchor lines on document changes, the way Monaco shifts view zones: changes
   * entirely above the anchor shift it by the net line count; changes that touch the anchor line and
   * change the line count mark the inset for rebuilding.
   */
  onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    for (const [ed, entries] of this.byEditor) {
      if (ed.document !== e.document) continue;
      for (const ch of e.contentChanges) {
        const delta = (ch.text.match(/\r\n|\r|\n/g)?.length ?? 0) - (ch.range.end.line - ch.range.start.line);
        for (const entry of entries.values()) {
          if (ch.range.end.line < entry.line) entry.line += delta;
          else if (ch.range.start.line <= entry.line && delta !== 0) entry.dirty = true;
        }
      }
    }
  }

  update(editor: vscode.TextEditor, pf: PendingFile | undefined, maxInsets: number): void {
    if (!this.available) return;
    const want = new Map<string, Wanted>();
    if (pf && pf.kind === 'text' && !pf.missing) {
      // Only create insets for hunks within one screen of the visible range, capped per editor; more are added on scroll
      const ranges = editor.visibleRanges;
      const top = ranges.length ? ranges[0].start.line : 0;
      const bottom = ranges.length ? ranges[ranges.length - 1].end.line : 0;
      const span = Math.max(bottom - top, 30);
      const center = (top + bottom) / 2;
      const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
      pf.hunks
        .filter((h) => h.removed.length > 0 && h.curStart >= top - span && h.curStart <= bottom + span + 1)
        .sort((a, b) => Math.abs(a.curStart - center) - Math.abs(b.curStart - center))
        .slice(0, maxInsets)
        .forEach((hunk) => {
          const truncated = hunk.removed.length > MAX_LINES_PER_INSET;
          const lines = truncated
            ? [...hunk.removed.slice(0, MAX_LINES_PER_INSET - 1), `… ${plural(hunk.removed.length - MAX_LINES_PER_INSET + 1, 'more line')}`]
            : hunk.removed;
          // An inset appears below `line`. The deletion is right before curStart, so anchor at curStart - 1 (-1 at the top of the file)
          want.set(hunk.id, {
            hunk,
            line: hunk.curStart - 1,
            lines,
            code: truncated ? MAX_LINES_PER_INSET - 1 : lines.length,
            sig: hash53(lines.join('\n') + '\u0000' + tabSize + '\u0000' + this.askEnabled),
          });
        });
    }

    let entries = this.byEditor.get(editor);
    if (!entries) {
      if (want.size === 0) return;
      entries = new Map();
      this.byEditor.set(editor, entries);
    }
    // Only touch the insets that changed, to avoid flicker
    for (const [id, e] of [...entries]) {
      const w = want.get(id);
      if (!w || e.dirty || e.line !== w.line || e.height !== w.lines.length || e.sig !== w.sig) {
        entries.delete(id);
        e.inset.dispose();
      }
    }
    for (const [id, w] of want) {
      if (entries.has(id)) continue;
      const entry = this.create(editor, pf!, w);
      if (!this.available) return this.disposeAll();
      if (entry) entries.set(id, entry);
    }
  }

  private create(editor: vscode.TextEditor, pf: PendingFile, w: Wanted): Entry | undefined {
    let inset: vscode.WebviewEditorInset;
    try {
      inset = vscode.window.createWebviewTextEditorInset(editor, w.line, w.lines.length, { enableScripts: true, localResourceRoots: [] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/proposal/i.test(msg)) {
        this.available = false;
        this.log(`editorInsets rejected, falling back to hovers: ${msg}`);
        this.unavailableEmitter.fire();
      } else if (!/not a visible editor/i.test(msg)) {
        // Happens when the editor was just closed or switched away; the next render retries, so do not log it
        this.log(`Failed to create an inset (line ${w.line + 1}): ${msg}`);
      }
      return undefined;
    }
    const entry: Entry = { inset, line: w.line, height: w.lines.length, sig: w.sig, dirty: false, ready: false, disposed: false };
    const languageId = editor.document.languageId;
    // If the file is already tokenized, embed colors now; otherwise draw plain text and send colors when ready
    const hl = this.highlighting;
    const tokens = hl?.peek(pf.path, pf.baseHash, languageId, pf.baseLines, w.hunk.baseStart, w.code);
    const cfg = vscode.workspace.getConfiguration('editor', editor.document);
    inset.webview.html = renderRemovedLines(
      w.lines,
      {
        tabSize: typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4,
        letterSpacing: cfg.get<number>('letterSpacing') ?? 0,
        ligatures: cfg.get<boolean | string>('fontLigatures') ?? false,
        ask: this.askEnabled,
      },
      tokens,
    );
    if (!tokens && hl) {
      void hl.highlight(pf.path, pf.baseHash, languageId, pf.baseLines, w.hunk.baseStart, w.code).then((spans) => {
        if (!spans || entry.disposed) return;
        if (entry.ready) void inset.webview.postMessage({ cmd: 'tokens', lines: spans });
        else entry.pendingTokens = spans;
      });
    }
    inset.webview.onDidReceiveMessage(
      (msg: { cmd?: string; h?: number; lineH?: number; fontFamily?: string; fontSize?: string; colored?: number }) => {
        switch (msg?.cmd) {
          case 'ready':
            entry.ready = true;
            if (entry.pendingTokens) {
              void inset.webview.postMessage({ cmd: 'tokens', lines: entry.pendingTokens });
              entry.pendingTokens = undefined;
            }
            break;
          case 'keep':
          case 'undo':
          case 'ask':
            this.onAction({ path: pf.path, hunkId: w.hunk.id, action: msg.cmd, editor });
            break;
          case 'metrics':
            if (this.metrics.length < 50) {
              this.metrics.push({ insetPx: msg.h ?? 0, lines: w.lines.length, linePx: msg.lineH ?? 0, fontFamily: msg.fontFamily ?? '', fontSize: msg.fontSize ?? '' });
            }
            break;
          case 'highlighted':
            if (this.highlighted.length < 200) this.highlighted.push(msg.colored ?? 0);
            break;
        }
      },
    );
    inset.onDidDispose(() => {
      entry.disposed = true;
      const m = this.byEditor.get(editor);
      if (m && m.get(w.hunk.id) === entry) m.delete(w.hunk.id);
    });
    return entry;
  }

  clear(editor: vscode.TextEditor): void {
    const entries = this.byEditor.get(editor);
    if (!entries) return;
    this.byEditor.delete(editor);
    for (const e of entries.values()) e.inset.dispose();
  }

  clearAll(): void {
    for (const ed of [...this.byEditor.keys()]) this.clear(ed);
  }

  private disposeAll(): void {
    this.clearAll();
  }

  dispose(): void {
    this.disposeAll();
    this.unavailableEmitter.dispose();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

function spanStyle(color: string | null, fontStyle: number): string {
  const css: string[] = [];
  if (color && COLOR_RE.test(color)) css.push(`color:${color}`);
  if (fontStyle & 1) css.push('font-style:italic');
  if (fontStyle & 2) css.push('font-weight:bold');
  const deco = [fontStyle & 4 ? 'underline' : '', fontStyle & 8 ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) css.push(`text-decoration:${deco}`);
  return css.join(';');
}

function renderRow(text: string, spans: StyledSpan[] | undefined): string {
  if (!spans) return escapeHtml(text) || ' ';
  const html = spans
    .map(([t, color, fs]) => {
      const style = spanStyle(color, fs);
      return style ? `<span style="${style}">${escapeHtml(t)}</span>` : escapeHtml(t);
    })
    .join('');
  return html || ' ';
}

export function renderRemovedLines(
  lines: readonly string[],
  o: { tabSize: number; letterSpacing: number; ligatures: boolean | string; ask?: boolean },
  tokens?: StyledSpan[][],
): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const features = o.ligatures === true ? '"liga" on, "calt" on' : typeof o.ligatures === 'string' && o.ligatures ? o.ligatures : '"liga" off, "calt" off';
  const rows = lines.map((l, i) => `<div class="l"><span>${renderRow(l, tokens?.[i])}</span></div>`).join('');
  const ask = o.ask ? '<button id="a" class="s" title="Ask Claude about this change (⌃⌥C)">Ask Claude</button>' : '';
  // Each line is flex: 1 and the inset is (lines x editor line height) tall, so every line gets exactly one line height without pixel math
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html,body{margin:0;padding:0;height:100%;overflow:hidden}
body{background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);font-weight:var(--vscode-editor-font-weight);font-feature-settings:${features};display:flex;flex-direction:column;cursor:default}
.l{flex:1 1 0;min-height:0;display:flex;align-items:center;white-space:pre;tab-size:${o.tabSize};letter-spacing:${o.letterSpacing}px;background:var(--vscode-diffEditor-removedLineBackground,rgba(255,0,0,.2));overflow:hidden}
body.vscode-high-contrast .l,body.vscode-high-contrast-light .l{outline:1px dashed var(--vscode-diffEditor-removedTextBorder,#f00);outline-offset:-1px}
.bar{position:fixed;top:0;right:14px;display:none;gap:4px}
body:hover .bar{display:flex}
button{font-family:var(--vscode-font-family);font-size:11px;line-height:16px;padding:0 6px;border:0;border-radius:3px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button.s{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
</style></head><body>${rows}
<div class="bar"><button id="k" title="Keep (⌃⌥K)">Keep</button><button id="u" class="s" title="Undo (⌃⌥U)">Undo</button>${ask}</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const [id, cmd] of [['k', 'keep'], ['u', 'undo'], ['a', 'ask']]) {
  const b = document.getElementById(id);
  if (b) b.addEventListener('click', () => vscode.postMessage({ cmd }));
}
const countColored = () => document.querySelectorAll('.l span span[style*="color"]').length;
// The extension sends colors once they are computed
addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.cmd !== 'tokens') return;
  const rows = document.querySelectorAll('.l > span');
  m.lines.forEach((spans, i) => {
    const el = rows[i];
    if (!el) return;
    el.textContent = '';
    for (const [text, color, fs] of spans) {
      const s = document.createElement('span');
      s.textContent = text;
      if (color && /^#[0-9a-fA-F]{3,8}$/.test(color)) s.style.color = color;
      if (fs & 1) s.style.fontStyle = 'italic';
      if (fs & 2) s.style.fontWeight = 'bold';
      const deco = [fs & 4 ? 'underline' : '', fs & 8 ? 'line-through' : ''].filter(Boolean).join(' ');
      if (deco) s.style.textDecoration = deco;
      el.appendChild(s);
    }
    if (!el.textContent) el.textContent = ' ';
  });
  vscode.postMessage({ cmd: 'highlighted', colored: countColored() });
});
vscode.postMessage({ cmd: 'ready' });
if (countColored() > 0) vscode.postMessage({ cmd: 'highlighted', colored: countColored() });
// Report measured sizes, used to check alignment. Not requestAnimationFrame: it pauses while the window is occluded
let last = -1;
const report = () => {
  if (innerHeight === last || innerHeight === 0) return;
  last = innerHeight;
  const r = document.querySelector('.l').getBoundingClientRect();
  const cs = getComputedStyle(document.body);
  vscode.postMessage({ cmd: 'metrics', h: innerHeight, lineH: r.height, fontFamily: cs.fontFamily, fontSize: cs.fontSize });
};
report();
addEventListener('load', report);
addEventListener('resize', report);
</script></body></html>`;
}
