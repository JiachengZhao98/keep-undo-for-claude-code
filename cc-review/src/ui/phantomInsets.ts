// Phantom lines: the proposed editorInsets API inserts a webview between two lines of code to draw the
// removed lines on a red background, colored with the active theme. When the API is unavailable
// (no --enable-proposed-api, or the API changed), the hover fallback in decorations.ts takes over.
// The same API puts Keep / Undo / Ask Claude buttons below each change, and a bar with Keep / Undo for the
// whole file above its first line.
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { Hunk } from '../core/diff';
import type { PendingFile } from '../core/model';
import { fileChangeSummary } from '../core/summary';
import { hash53, plural } from '../core/text';
import type { StyledSpan } from '../core/textmate';

const MAX_LINES_PER_INSET = 400;
/** Key of the file bar among an editor's insets (hunk ids never start with #) */
const FILE_BAR = '#file';
const FILE_BAR_LINES = 2;
/** Suffix of the key of the buttons inset below a change (after its hunk id) */
const BUTTONS = '#buttons';

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
  /** File bar: the summary shown, and one not yet sent to the webview */
  summary?: string;
  pendingSummary?: string;
  /** Holds a change's Keep / Undo / Ask Claude buttons */
  buttons: boolean;
  disposed: boolean;
}

interface Wanted {
  hunk: Hunk;
  line: number;
  /** Removed lines to draw in red; empty for an inset that only holds buttons */
  lines: string[];
  /** Number of lines to color (when truncated, the last line is the "N more lines" note) */
  code: number;
  /** A row of Keep / Undo / Ask Claude buttons below the lines */
  buttons: boolean;
  sig: string;
}

const heightOf = (w: Wanted) => w.lines.length + (w.buttons ? 1 : 0);

export interface InsetAction {
  path: string;
  /** Empty for the whole-file actions */
  hunkId: string;
  action: 'keep' | 'undo' | 'ask' | 'keepFile' | 'undoFile';
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
  /** Show the Keep / Undo bar for the whole file at the top of each pending file */
  fileButtons = true;
  /** Show Keep / Undo / Ask Claude buttons below each change */
  changeButtons = true;

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

  /** Phantom line insets (not counting file bars and button rows) */
  get insetCount(): number {
    let n = 0;
    for (const m of this.byEditor.values()) for (const id of m.keys()) if (id !== FILE_BAR && !id.endsWith(BUTTONS)) n++;
    return n;
  }

  /** Changes that show Keep / Undo / Ask Claude buttons */
  get changeButtonCount(): number {
    let n = 0;
    for (const m of this.byEditor.values()) for (const e of m.values()) if (e.buttons) n++;
    return n;
  }

  get fileBarCount(): number {
    let n = 0;
    for (const m of this.byEditor.values()) if (m.has(FILE_BAR)) n++;
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
        .filter((h) => (h.removed.length > 0 || this.changeButtons) && h.curStart >= top - span && h.curStart <= bottom + span + 1)
        .sort((a, b) => Math.abs(a.curStart - center) - Math.abs(b.curStart - center))
        .slice(0, maxInsets)
        .forEach((hunk) => {
          if (hunk.removed.length > 0) {
            const truncated = hunk.removed.length > MAX_LINES_PER_INSET;
            const lines = truncated
              ? [...hunk.removed.slice(0, MAX_LINES_PER_INSET - 1), `… ${plural(hunk.removed.length - MAX_LINES_PER_INSET + 1, 'more line')}`]
              : hunk.removed;
            // A pure deletion has no lines of its own below the red ones, so its buttons go in the same inset;
            // one inset keeps them in order (two insets on the same line can swap when one is rebuilt)
            const buttons = this.changeButtons && hunk.added === 0;
            // An inset appears below `line`. The deletion is right before curStart, so anchor at curStart - 1 (-1 at the top of the file)
            want.set(hunk.id, {
              hunk,
              line: hunk.curStart - 1,
              lines,
              code: truncated ? MAX_LINES_PER_INSET - 1 : lines.length,
              buttons,
              sig: hash53(lines.join('\n') + '\u0000' + tabSize + '\u0000' + (buttons ? `buttons:${this.askEnabled}` : '')),
            });
          }
          if (this.changeButtons && hunk.added > 0) {
            // Below the last line of the change
            want.set(hunk.id + BUTTONS, { hunk, line: hunk.curStart + hunk.added - 1, lines: [], code: 0, buttons: true, sig: `buttons:${this.askEnabled}` });
          }
        });
    }

    const summary = this.fileButtons && pf && !pf.missing ? fileChangeSummary(pf) : undefined;
    let entries = this.byEditor.get(editor);
    if (!entries) {
      if (want.size === 0 && summary === undefined) return;
      entries = new Map();
      this.byEditor.set(editor, entries);
    }
    // The file bar is created first so it sits above a phantom inset at the top of the file
    const bar = entries.get(FILE_BAR);
    if (bar && summary === undefined) {
      entries.delete(FILE_BAR);
      bar.inset.dispose();
    } else if (bar && summary !== bar.summary) {
      // Update the text in place rather than rebuilding the webview
      bar.summary = summary;
      if (bar.ready) void bar.inset.webview.postMessage({ cmd: 'summary', text: summary });
      else bar.pendingSummary = summary;
    } else if (!bar && summary !== undefined) {
      const entry = this.createFileBar(editor, pf!, summary);
      if (!this.available) return this.disposeAll();
      if (entry) entries.set(FILE_BAR, entry);
    }
    // Only touch the insets that changed, to avoid flicker
    for (const [id, e] of [...entries]) {
      if (id === FILE_BAR) continue;
      const w = want.get(id);
      if (!w || e.dirty || e.line !== w.line || e.height !== heightOf(w) || e.sig !== w.sig) {
        entries.delete(id);
        e.inset.dispose();
      }
    }
    for (const [id, w] of want) {
      if (entries.has(id)) continue;
      const entry = this.create(editor, pf!, w, id);
      if (!this.available) return this.disposeAll();
      if (entry) entries.set(id, entry);
    }
  }

  private create(editor: vscode.TextEditor, pf: PendingFile, w: Wanted, id: string): Entry | undefined {
    let inset: vscode.WebviewEditorInset;
    try {
      inset = vscode.window.createWebviewTextEditorInset(editor, w.line, heightOf(w), { enableScripts: true, localResourceRoots: [] });
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
    const entry: Entry = { inset, line: w.line, height: heightOf(w), sig: w.sig, dirty: false, ready: false, disposed: false, buttons: w.buttons };
    const languageId = editor.document.languageId;
    // If the file is already tokenized, embed colors now; otherwise draw plain text and send colors when ready
    const hl = w.lines.length ? this.highlighting : undefined;
    const tokens = hl?.peek(pf.path, pf.baseHash, languageId, pf.baseLines, w.hunk.baseStart, w.code);
    const cfg = vscode.workspace.getConfiguration('editor', editor.document);
    inset.webview.html = w.lines.length
      ? renderRemovedLines(
          w.lines,
          {
            tabSize: typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4,
            letterSpacing: cfg.get<number>('letterSpacing') ?? 0,
            ligatures: cfg.get<boolean | string>('fontLigatures') ?? false,
            buttons: w.buttons,
            ask: this.askEnabled,
          },
          tokens,
        )
      : renderChangeButtons(this.askEnabled);
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
              this.metrics.push({ insetPx: msg.h ?? 0, lines: heightOf(w), linePx: msg.lineH ?? 0, fontFamily: msg.fontFamily ?? '', fontSize: msg.fontSize ?? '' });
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
      if (m && m.get(id) === entry) m.delete(id);
    });
    return entry;
  }

  private createFileBar(editor: vscode.TextEditor, pf: PendingFile, summary: string): Entry | undefined {
    let inset: vscode.WebviewEditorInset;
    try {
      // Line -1: above the first line of the file
      inset = vscode.window.createWebviewTextEditorInset(editor, -1, FILE_BAR_LINES, { enableScripts: true, localResourceRoots: [] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/proposal/i.test(msg)) {
        this.available = false;
        this.log(`editorInsets rejected, falling back to hovers: ${msg}`);
        this.unavailableEmitter.fire();
      } else if (!/not a visible editor/i.test(msg)) {
        this.log(`Failed to create the file bar: ${msg}`);
      }
      return undefined;
    }
    const entry: Entry = { inset, line: -1, height: FILE_BAR_LINES, sig: '', dirty: false, ready: false, disposed: false, buttons: false, summary };
    inset.webview.html = renderFileBar(summary, !pf.existed);
    inset.webview.onDidReceiveMessage((msg: { cmd?: string }) => {
      if (msg?.cmd === 'ready') {
        entry.ready = true;
        if (entry.pendingSummary !== undefined) void inset.webview.postMessage({ cmd: 'summary', text: entry.pendingSummary });
        entry.pendingSummary = undefined;
      } else if (msg?.cmd === 'keepFile' || msg?.cmd === 'undoFile') {
        this.onAction({ path: pf.path, hunkId: '', action: msg.cmd, editor });
      }
    });
    inset.onDidDispose(() => {
      entry.disposed = true;
      const m = this.byEditor.get(editor);
      if (m && m.get(FILE_BAR) === entry) m.delete(FILE_BAR);
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

/** Button colors: blue Keep, red Undo, and Claude's orange for Ask Claude, with variants per theme kind */
const BUTTON_CSS = `
:root{--keep:#0969da;--keep-hover:#0757ba;--undo:#cf222e;--ask:#c15f3c;--ask-hover:#a9512f}
body.vscode-dark{--keep:#1f6feb;--keep-hover:#1158c7;--undo:#f85149;--ask:#c15f3c;--ask-hover:#d97757}
body.vscode-high-contrast{--keep:#1f6feb;--keep-hover:#1158c7;--undo:#ff7b72;--ask:#c15f3c;--ask-hover:#d97757}
body.vscode-high-contrast-light{--keep:#0349b4;--keep-hover:#023b95;--undo:#a40e26;--ask:#9c4a2b;--ask-hover:#843f25}
button{display:inline-flex;align-items:center;gap:4px;font-family:var(--vscode-font-family);font-weight:600;border:1px solid;border-radius:4px;cursor:pointer;white-space:nowrap}
button.keep{background:var(--keep);border-color:var(--keep);color:#fff}
button.keep:hover{background:var(--keep-hover);border-color:var(--keep-hover)}
button.undo{background:transparent;border-color:var(--undo);color:var(--undo)}
button.undo:hover{background:color-mix(in srgb,var(--undo) 14%,transparent)}
button.ask{background:var(--ask);border-color:var(--ask);color:#fff}
button.ask:hover{background:var(--ask-hover);border-color:var(--ask-hover)}
button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
`;

/** Compact enough to fit one editor line */
const CHANGE_BUTTON_CSS = '.btns{display:flex;align-items:center;gap:6px}.btns button{font-size:11px;line-height:14px;padding:0 7px}';

function changeButtons(ask: boolean): string {
  const askButton = ask ? '<button class="ask" data-cmd="ask" type="button" title="Ask Claude about this change (⌃⌥C)">Ask Claude</button>' : '';
  return (
    '<button class="keep" data-cmd="keep" type="button" title="Keep this change (⌃⌥K)">✓ Keep</button>' +
    '<button class="undo" data-cmd="undo" type="button" title="Undo this change (⌃⌥U)">↺ Undo</button>' +
    askButton
  );
}

const CHANGE_BUTTON_SCRIPT = `for (const b of document.querySelectorAll('button[data-cmd]')) b.addEventListener('click', () => vscode.postMessage({ cmd: b.dataset.cmd }));`;

export function renderRemovedLines(
  lines: readonly string[],
  o: { tabSize: number; letterSpacing: number; ligatures: boolean | string; buttons?: boolean; ask?: boolean },
  tokens?: StyledSpan[][],
): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const features = o.ligatures === true ? '"liga" on, "calt" on' : typeof o.ligatures === 'string' && o.ligatures ? o.ligatures : '"liga" off, "calt" off';
  const rows = lines.map((l, i) => `<div class="l"><span>${renderRow(l, tokens?.[i])}</span></div>`).join('');
  const buttons = o.buttons ? `<div class="btns">${changeButtons(!!o.ask)}</div>` : '';
  // Each row is flex: 1 and the inset is (rows x editor line height) tall, so every row gets exactly one line height without pixel math
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html,body{margin:0;padding:0;height:100%;overflow:hidden}
body{background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);font-weight:var(--vscode-editor-font-weight);font-feature-settings:${features};display:flex;flex-direction:column;cursor:default}
.l{flex:1 1 0;min-height:0;display:flex;align-items:center;white-space:pre;tab-size:${o.tabSize};letter-spacing:${o.letterSpacing}px;background:var(--vscode-diffEditor-removedLineBackground,rgba(255,0,0,.2));overflow:hidden}
body.vscode-high-contrast .l,body.vscode-high-contrast-light .l{outline:1px dashed var(--vscode-diffEditor-removedTextBorder,#f00);outline-offset:-1px}
.btns{flex:1 1 0;min-height:0}
${BUTTON_CSS}${CHANGE_BUTTON_CSS}
</style></head><body>${rows}${buttons}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
${CHANGE_BUTTON_SCRIPT}
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

/** The one-line row of Keep / Undo / Ask Claude buttons below a change */
export function renderChangeButtons(ask: boolean): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html,body{margin:0;padding:0;height:100%;overflow:hidden}
body{display:flex;align-items:center;background:var(--vscode-editor-background);cursor:default}
${BUTTON_CSS}${CHANGE_BUTTON_CSS}
</style></head><body><div class="btns">${changeButtons(ask)}</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
${CHANGE_BUTTON_SCRIPT}
vscode.postMessage({ cmd: 'ready' });
</script></body></html>`;
}

/** The bar above a pending file: a blue Keep and a red Undo for the whole file, then a summary */
export function renderFileBar(summary: string, newFile: boolean): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const undoTitle = newFile ? 'Undo: delete this file Claude created' : "Undo all of Claude's changes to this file";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${BUTTON_CSS}
html,body{margin:0;padding:0;height:100%;overflow:hidden}
body{display:flex;align-items:center;gap:6px;background:var(--vscode-editor-background);color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);font-size:12px;white-space:nowrap;cursor:default}
button{font-size:12px;line-height:18px;padding:1px 10px}
#s{margin-left:6px;overflow:hidden;text-overflow:ellipsis}
</style></head><body>
<button id="k" class="keep" type="button" title="Keep all of Claude's changes to this file">✓ Keep</button>
<button id="u" class="undo" type="button" title="${undoTitle}">↺ Undo</button>
<span id="s">${escapeHtml(summary)}</span>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('k').addEventListener('click', () => vscode.postMessage({ cmd: 'keepFile' }));
document.getElementById('u').addEventListener('click', () => vscode.postMessage({ cmd: 'undoFile' }));
addEventListener('message', (e) => {
  if (e.data && e.data.cmd === 'summary') document.getElementById('s').textContent = e.data.text;
});
vscode.postMessage({ cmd: 'ready' });
</script></body></html>`;
}
