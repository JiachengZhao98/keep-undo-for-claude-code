// Phantom lines: the proposed editorInsets API inserts a webview between two lines of code to draw the
// removed lines on a red background, colored with the active theme. When the API is unavailable
// (no --enable-proposed-api, or the API changed), the hover fallback in decorations.ts takes over.
// The same API puts Keep / Undo / Ask Claude buttons below each change, and a bar with Keep / Undo for the
// whole file above its first line.
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { Hunk } from '../core/diff';
import { planInsets, previewCss } from '../core/insets';
import type { PendingFile } from '../core/model';
import { fileChangeSummary } from '../core/summary';
import { hash53, plural } from '../core/text';
import type { StyledSpan } from '../core/textmate';
import { InsetScroller } from './insetScroll';

const MAX_LINES_PER_INSET = 400;
const FILE_BAR_LINES = 2;
/** Insets outside the visible range are created this many at a time, each group once the one before is running */
const BATCH = 6;
/** How long a running inset may take to answer a ping after the window's layout changed, the window's own delays not counted */
const PING_TIMEOUT_MS = 300;
/** Every inset is pinged this often, and counts as stopped after missing two pings in a row */
const HEARTBEAT_MS = 5000;

/** Syntax highlighting (SyntaxHighlighter in ui/highlight.ts) */
export interface Highlighting {
  peek(docKey: string, hash: string, languageId: string, lines: readonly string[], from: number, count: number): StyledSpan[][] | undefined;
  highlight(docKey: string, hash: string, languageId: string, lines: readonly string[], from: number, count: number): Promise<StyledSpan[][] | undefined>;
}

/** The bar above the file, a block of deleted lines (with a change's buttons below them when it added nothing), or a row of buttons */
type Kind = 'bar' | 'lines' | 'buttons';

interface Wanted {
  kind: 'lines' | 'buttons';
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

interface Entry {
  inset: vscode.WebviewEditorInset;
  kind: Kind;
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
  /** The file, and the change the inset shows now: an inset stays when the change at its place gets a new id */
  pf: PendingFile;
  want?: Wanted;
  /** performance.now() when the inset was created, and whether its start time has been recorded */
  t0: number;
  timed: boolean;
  /** How many pings had gone out when the inset was created, the last ping it answered, and the regular pings sent since its last answer */
  since: number;
  ponged: number;
  silent: number;
  /** The webview has drawn its content, so the preview of its lines is not needed any more */
  shown: boolean;
}

const heightOf = (w: Wanted) => w.lines.length + (w.buttons ? 1 : 0);

export interface InsetAction {
  path: string;
  /** Empty for the whole-file actions and for focus */
  hunkId: string;
  /** focus: a click in an inset that was not on a button left keyboard focus in its webview */
  action: 'keep' | 'undo' | 'ask' | 'keepFile' | 'undoFile' | 'focus';
  editor: vscode.TextEditor;
}

export interface InsetMetrics {
  insetPx: number;
  lines: number;
  linePx: number;
  fontFamily: string;
  fontSize: string;
}

interface InsetMessage {
  cmd?: string;
  h?: number;
  lineH?: number;
  fontFamily?: string;
  fontSize?: string;
  colored?: number;
  lines?: number;
  alt?: boolean;
  y?: number;
  n?: number;
}

export class PhantomInsets implements vscode.Disposable {
  private available: boolean;
  private readonly byEditor = new Map<vscode.TextEditor, Entry[]>();
  private readonly unavailableEmitter = new vscode.EventEmitter<void>();
  readonly onDidBecomeUnavailable = this.unavailableEmitter.event;
  private readonly updateEmitter = new vscode.EventEmitter<vscode.TextEditor>();
  /** An editor has insets left to create and is ready for the next few: call update for it again */
  readonly onDidWantUpdate = this.updateEmitter.event;
  /** Editors waiting for their insets to start before the next ones are created */
  private readonly waiting = new Map<vscode.TextEditor, NodeJS.Timeout>();
  private readonly scroller = new InsetScroller();
  /**
   * Draws an inset's deleted lines in its place while its webview starts, which takes a moment: plain
   * text on the red background, in the editor's own font. The webview then covers it with the colored lines.
   */
  private readonly preview = vscode.window.createTextEditorDecorationType({ rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
  /** What the preview decorations of each editor show now */
  private readonly previewed = new WeakMap<vscode.TextEditor, string>();
  private pings = 0;
  private checkTimer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  /** Insets created again because they had stopped running (for tests and debugging) */
  revived = 0;
  readonly metrics: InsetMetrics[] = [];
  /** Number of colored spans each inset reports after highlighting (for tests and debugging) */
  readonly highlighted: number[] = [];
  /** Insets created so far, file bars included (for tests and debugging) */
  created = 0;
  /** Times an inset reported its colors, including after a recolor (for tests) */
  highlightReports = 0;
  /** Wheel events received from insets (for tests) */
  wheelEvents = 0;
  /** Milliseconds from creating each inset to its webview running (for tests and debugging) */
  readonly readyTimes: number[] = [];
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

  private count(test: (e: Entry) => boolean): number {
    let n = 0;
    for (const entries of this.byEditor.values()) for (const e of entries) if (test(e)) n++;
    return n;
  }

  /** Phantom line insets (not counting file bars and button rows) */
  get insetCount(): number {
    return this.count((e) => e.kind === 'lines');
  }

  /** Changes that show Keep / Undo / Ask Claude buttons */
  get changeButtonCount(): number {
    return this.count((e) => e.buttons);
  }

  /** Insets that hold both deleted lines and buttons (a change that only deleted lines) */
  get bothCount(): number {
    return this.count((e) => e.kind === 'lines' && e.buttons);
  }

  /** Insets whose webview has not started yet */
  get loadingCount(): number {
    return this.count((e) => !e.ready);
  }

  get fileBarCount(): number {
    return this.count((e) => e.kind === 'bar');
  }

  /** Editors that are no longer visible: their insets died with them, so drop the records */
  retainEditors(visible: readonly vscode.TextEditor[]): void {
    const keep = new Set(visible);
    for (const ed of [...this.byEditor.keys()]) if (!keep.has(ed)) this.clear(ed);
  }

  /** The editor's visible range changed */
  noteScrolled(editor: vscode.TextEditor): void {
    this.scroller.noteScrolled(editor);
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
        for (const entry of entries) {
          if (ch.range.end.line < entry.line) entry.line += delta;
          else if (ch.range.start.line <= entry.line && delta !== 0) entry.dirty = true;
        }
      }
    }
  }

  /** Every inset the file's changes call for */
  private wanted(editor: vscode.TextEditor, pf: PendingFile | undefined): Wanted[] {
    const out: Wanted[] = [];
    if (!pf || pf.kind !== 'text' || pf.missing) return out;
    const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
    for (const hunk of pf.hunks) {
      if (hunk.removed.length > 0) {
        const truncated = hunk.removed.length > MAX_LINES_PER_INSET;
        const lines = truncated
          ? [...hunk.removed.slice(0, MAX_LINES_PER_INSET - 1), `… ${plural(hunk.removed.length - MAX_LINES_PER_INSET + 1, 'more line')}`]
          : hunk.removed;
        // A pure deletion has no lines of its own below the red ones, so its buttons go in the same inset;
        // one inset keeps them in order (two insets on the same line can swap when one is rebuilt)
        const buttons = this.changeButtons && hunk.added === 0;
        // An inset appears below `line`. The deletion is right before curStart, so anchor at curStart - 1 (-1 at the top of the file)
        out.push({
          kind: 'lines',
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
        out.push({ kind: 'buttons', hunk, line: hunk.curStart + hunk.added - 1, lines: [], code: 0, buttons: true, sig: `buttons:${this.askEnabled}` });
      }
    }
    return out;
  }

  /**
   * Bring an editor's insets in line with its file's changes.
   *
   * Each inset is a webview, and VS Code runs every webview in a process of its own: creating one
   * costs a process start, so an inset is created once and then reused for as long as a change needs
   * one at its place, whatever happens to the change's content or id. Insets in view are created at
   * once; the rest of the file's follow a few at a time, nearest first, so that scrolling finds them
   * all drawn already. They stay while the editor shows the file, up to `maxInsets` (the file bar not
   * counted): past that, the farthest from view make room for nearer ones. An inset that appears or
   * disappears above the visible range moves the text in view, which is scrolled back by as much.
   */
  update(editor: vscode.TextEditor, pf: PendingFile | undefined, maxInsets: number): void {
    if (!this.available) return;
    const wanted = this.wanted(editor, pf);
    const summary = this.fileButtons && pf && !pf.missing ? fileChangeSummary(pf) : undefined;
    let entries = this.byEditor.get(editor);
    if (!entries) {
      if (wanted.length === 0 && summary === undefined) return;
      entries = [];
      this.byEditor.set(editor, entries);
    }
    const list = entries;
    const ranges = editor.visibleRanges;
    const top = ranges.length ? ranges[0].start.line : 0;
    const bottom = ranges.length ? ranges[ranges.length - 1].end.line : 0;
    // Lines of insets added above the first visible line, minus lines removed there
    let shift = 0;
    const drop = (e: Entry) => {
      if (e.line < top) shift -= e.height;
      // Its onDidDispose handler takes it off the list
      e.inset.dispose();
    };
    const add = (e: Entry | undefined) => {
      if (!e) return;
      list.push(e);
      if (e.line < top) shift += e.height;
    };

    let bar = list.find((e) => e.kind === 'bar');
    if (bar && (summary === undefined || bar.dirty)) {
      drop(bar);
      bar = undefined;
    }
    if (bar && summary !== bar.summary) {
      // Update the text in place rather than rebuilding the webview
      bar.summary = summary;
      if (bar.ready) void bar.inset.webview.postMessage({ cmd: 'summary', text: summary });
      else bar.pendingSummary = summary;
    } else if (!bar && summary !== undefined) {
      // Created first so it sits above a phantom inset at the top of the file
      add(this.createFileBar(editor, pf!, summary));
      if (!this.available) return this.disposeAll();
    }

    // Keep the insets that already sit where a change needs one; dispose the rest
    const current = list.filter((e) => e.kind !== 'bar');
    const plan = planInsets(
      current,
      wanted.map((w) => ({ kind: w.kind, line: w.line, height: heightOf(w) })),
    );
    for (const i of plan.dispose) drop(current[i]);
    for (const [i, j] of plan.reuse) this.show(editor, current[i], pf!, wanted[j]);

    const center = (top + bottom) / 2;
    const distance = (line: number) => Math.abs(line - center);
    const missing = plan.create.map((j) => wanted[j]).sort((a, b) => distance(a.line) - distance(b.line));
    // Starting many processes at once slows each of them down: the insets in view go first and alone
    let room = list.some((e) => !e.ready) ? 0 : BATCH;
    let more = false;
    for (const w of missing) {
      const inView = w.line >= top - 1 && w.line <= bottom;
      // Above the visible range, an inset needs the scrolling back, which is not safe right now
      if (!inView && (room <= 0 || (w.line < top && !this.scroller.canCompensate(editor)))) {
        more = true;
        continue;
      }
      if (list.length - (list.some((e) => e.kind === 'bar') ? 1 : 0) >= maxInsets) {
        // At the cap: make room by dropping the inset farthest from view, if it is farther than this one
        let far: Entry | undefined;
        for (const e of list) if (e.kind !== 'bar' && (!far || distance(e.line) > distance(far.line))) far = e;
        if (!far || distance(far.line) <= distance(w.line)) break;
        drop(far);
      }
      add(this.create(editor, pf!, w));
      if (!this.available) return this.disposeAll();
      room = inView ? 0 : room - 1;
    }
    if (more) this.wait(editor);
    this.paintPreviews(editor);
    // At the very top of the file, an inset above the first line belongs in view
    if (shift !== 0 && top > 0) this.scroller.compensate(editor, shift, top, list);
    this.beat();
  }

  /** Draw the lines of the insets whose webview has nothing to show yet, and stop drawing those of the others */
  private paintPreviews(editor: vscode.TextEditor): void {
    if (!vscode.window.visibleTextEditors.includes(editor)) return;
    const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
    const last = editor.document.lineCount - 1;
    const options: vscode.DecorationOptions[] = [];
    const keys: string[] = [];
    for (const e of this.byEditor.get(editor) ?? []) {
      if (e.kind !== 'lines' || e.shown || e.dirty || !e.want || e.line > last) continue;
      // The inset is the first thing below the first row of its line (a wrapped line has several rows), so the preview
      // hangs below the start of that line; an inset before the first line is the last thing above it
      const above = e.line < 0;
      const at = new vscode.Position(Math.max(e.line, 0), 0);
      const attachment = { contentText: ' ', textDecoration: previewCss(e.want.lines, tabSize, above) };
      options.push({ range: new vscode.Range(at, at), renderOptions: { before: attachment } });
      keys.push(`${e.line}:${e.sig}`);
    }
    const key = keys.join('|');
    if ((this.previewed.get(editor) ?? '') === key) return;
    this.previewed.set(editor, key);
    editor.setDecorations(this.preview, options);
  }

  /**
   * Find the insets that stopped running, so that they are created again. VS Code reloads an inset's
   * frame when its editor moves within the window (an editor group is split, closed or moved, the
   * layout is turned), and a reloaded frame stays empty for good. A running inset answers a ping.
   * Call this when the layout may have changed: an inset that stays silent then counts as stopped.
   * Other causes are caught by the pings sent every few seconds.
   */
  check(): void {
    clearTimeout(this.checkTimer);
    // Several events arrive for one change of layout: wait for the last
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      void this.pingAndRevive();
    }, 100);
  }

  private async pingAndRevive(): Promise<void> {
    const n = this.ping();
    // The pings and their answers pass through the window, which is busy right when its layout changes. A
    // round trip to it before and after the wait takes its delays out: once the second one is back, every
    // answer that reached the window in time has reached us too
    const echo = () => vscode.commands.executeCommand('setContext', 'ccReview.insetCheck', true).then(undefined, () => undefined);
    await echo();
    await new Promise((resolve) => setTimeout(resolve, PING_TIMEOUT_MS));
    await echo();
    this.revive((e) => e.since < n && e.ponged < n);
  }

  /** Ping every inset; returns the ping's number, which the answers carry */
  private ping(): number {
    const n = ++this.pings;
    // A webview that is still loading gets the message once it runs
    for (const entries of this.byEditor.values()) for (const e of entries) void e.inset.webview.postMessage({ cmd: 'ping', n });
    return n;
  }

  /** Mark the insets that match as stopped and ask for their editors to be updated */
  private revive(stopped: (e: Entry) => boolean): void {
    for (const [editor, entries] of this.byEditor) {
      let any = false;
      for (const e of entries) {
        // One that has not started yet answers when it does; it gets a few seconds for that
        if (e.dirty || !stopped(e) || (!e.ready && performance.now() - e.t0 < HEARTBEAT_MS)) continue;
        e.dirty = true;
        this.revived++;
        any = true;
      }
      if (any) this.updateEmitter.fire(editor);
    }
  }

  /** Keep pinging while there are insets */
  private beat(): void {
    if (this.heartbeat || this.count(() => true) === 0) return;
    this.heartbeat = setInterval(() => {
      if (this.count(() => true) === 0) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        return;
      }
      // Not while the window is in the background, where frames may be slow to answer
      if (!vscode.window.state.focused) return;
      // Silent through the last two pings
      this.revive((e) => e.silent >= 2);
      for (const entries of this.byEditor.values()) for (const e of entries) e.silent++;
      this.ping();
    }, HEARTBEAT_MS);
  }

  /** Call for another update once the editor's insets are all running, or after a moment if one takes long */
  private wait(editor: vscode.TextEditor): void {
    if (!this.waiting.has(editor)) this.waiting.set(editor, setTimeout(() => this.resume(editor), 800));
  }

  private resume(editor: vscode.TextEditor): void {
    const timer = this.waiting.get(editor);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.waiting.delete(editor);
    if (this.byEditor.has(editor)) this.updateEmitter.fire(editor);
  }

  /** Recolor the deleted lines in place (after a theme switch or a change to ccReview.syntaxHighlight) instead of rebuilding them */
  recolorAll(): void {
    for (const [editor, entries] of this.byEditor) for (const e of entries) if (e.kind === 'lines') this.color(editor, e, true);
  }

  /** Report a failed createWebviewTextEditorInset; the proposal being rejected turns insets off for good */
  private failed(err: unknown, what: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (/proposal/i.test(msg)) {
      this.available = false;
      this.log(`editorInsets rejected, falling back to hovers: ${msg}`);
      this.unavailableEmitter.fire();
    } else if (!/not a visible editor/i.test(msg)) {
      // Happens when the editor was just closed or switched away; the next render retries, so do not log it
      this.log(`Failed to create ${what}: ${msg}`);
    }
  }

  private create(editor: vscode.TextEditor, pf: PendingFile, w: Wanted): Entry | undefined {
    let inset: vscode.WebviewEditorInset;
    try {
      inset = vscode.window.createWebviewTextEditorInset(editor, w.line, heightOf(w), { enableScripts: true, localResourceRoots: [] });
    } catch (err) {
      this.failed(err, `an inset (line ${w.line + 1})`);
      return undefined;
    }
    this.created++;
    const entry: Entry = {
      inset,
      kind: w.kind,
      line: w.line,
      height: heightOf(w),
      sig: w.sig,
      dirty: false,
      ready: false,
      disposed: false,
      buttons: w.buttons,
      pf,
      want: w,
      t0: performance.now(),
      timed: false,
      since: this.pings,
      ponged: 0,
      silent: 0,
      shown: false,
    };
    this.fill(editor, entry);
    this.listen(editor, entry);
    return entry;
  }

  /** Point an inset at the change that now has its place; load that change's content when it differs from what the inset shows */
  private show(editor: vscode.TextEditor, entry: Entry, pf: PendingFile, w: Wanted): void {
    entry.pf = pf;
    entry.want = w;
    entry.buttons = w.buttons;
    if (entry.sig === w.sig) return;
    entry.sig = w.sig;
    this.fill(editor, entry);
  }

  /** Load the content of the inset's change into its webview (the same webview on later calls: no new process) */
  private fill(editor: vscode.TextEditor, entry: Entry): void {
    const w = entry.want;
    if (!w) return;
    const pf = entry.pf;
    // If the file is already tokenized, embed colors now; otherwise draw plain text and send colors when ready
    const tokens = w.lines.length ? this.highlighting?.peek(pf.path, pf.baseHash, editor.document.languageId, pf.baseLines, w.hunk.baseStart, w.code) : undefined;
    const cfg = vscode.workspace.getConfiguration('editor', editor.document);
    entry.ready = false;
    entry.pendingTokens = undefined;
    entry.inset.webview.html = w.lines.length
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
    if (!tokens) this.color(editor, entry, false);
  }

  /** Compute the colors of an inset's deleted lines and send them to its webview. On a recolor, plain text replaces old colors when highlighting is now off or the theme has no colors */
  private color(editor: vscode.TextEditor, entry: Entry, plainIfNone: boolean): void {
    const hl = this.highlighting;
    const w = entry.want;
    if (!hl || !w || w.lines.length === 0) return;
    const pf = entry.pf;
    void hl.highlight(pf.path, pf.baseHash, editor.document.languageId, pf.baseLines, w.hunk.baseStart, w.code).then((found) => {
      // The inset may be gone or show other lines by now
      if (entry.disposed || entry.sig !== w.sig) return;
      const spans = found ?? (plainIfNone ? w.lines.slice(0, w.code).map((l): StyledSpan[] => [[l, null, 0]]) : undefined);
      if (!spans) return;
      if (entry.ready) void entry.inset.webview.postMessage({ cmd: 'tokens', lines: spans });
      else entry.pendingTokens = spans;
    });
  }

  private listen(editor: vscode.TextEditor, entry: Entry): void {
    const { inset } = entry;
    inset.webview.onDidReceiveMessage((msg: InsetMessage) => {
      switch (msg?.cmd) {
        case 'ready':
          entry.ready = true;
          if (!entry.timed) {
            entry.timed = true;
            if (this.readyTimes.length < 2000) this.readyTimes.push(Math.round(performance.now() - entry.t0));
          }
          if (entry.pendingTokens) {
            void inset.webview.postMessage({ cmd: 'tokens', lines: entry.pendingTokens });
            entry.pendingTokens = undefined;
          }
          if (entry.pendingSummary !== undefined) {
            void inset.webview.postMessage({ cmd: 'summary', text: entry.pendingSummary });
            entry.pendingSummary = undefined;
          }
          // The insets of this editor are all running: time for the next ones
          if (this.waiting.has(editor) && !(this.byEditor.get(editor) ?? []).some((e) => !e.ready)) setTimeout(() => this.resume(editor), 0);
          // The script runs just before the webview shows its content: leave the preview a moment longer
          if (!entry.shown) {
            setTimeout(() => {
              entry.shown = true;
              if (!entry.disposed) this.paintPreviews(editor);
            }, 80);
          }
          break;
        case 'keep':
        case 'undo':
        case 'ask':
          if (entry.want) this.onAction({ path: entry.pf.path, hunkId: entry.want.hunk.id, action: msg.cmd, editor });
          break;
        case 'keepFile':
        case 'undoFile':
          this.onAction({ path: entry.pf.path, hunkId: '', action: msg.cmd, editor });
          break;
        case 'wheel':
          this.wheelEvents++;
          this.scroller.wheel(editor, Number(msg.lines), !!msg.alt, Number(msg.y), Number(msg.h), () => this.byEditor.get(editor) ?? []);
          break;
        case 'focus':
          this.onAction({ path: entry.pf.path, hunkId: '', action: 'focus', editor });
          break;
        case 'pong':
          entry.ponged = Math.max(entry.ponged, Number(msg.n) || 0);
          entry.silent = 0;
          break;
        case 'metrics':
          if (this.metrics.length < 50) {
            this.metrics.push({ insetPx: msg.h ?? 0, lines: entry.height, linePx: msg.lineH ?? 0, fontFamily: msg.fontFamily ?? '', fontSize: msg.fontSize ?? '' });
          }
          break;
        case 'highlighted':
          this.highlightReports++;
          if (this.highlighted.length < 200) this.highlighted.push(msg.colored ?? 0);
          break;
      }
    });
    inset.onDidDispose(() => {
      entry.disposed = true;
      const entries = this.byEditor.get(editor);
      const i = entries ? entries.indexOf(entry) : -1;
      if (i >= 0) entries!.splice(i, 1);
    });
  }

  private createFileBar(editor: vscode.TextEditor, pf: PendingFile, summary: string): Entry | undefined {
    let inset: vscode.WebviewEditorInset;
    try {
      // Line -1: above the first line of the file
      inset = vscode.window.createWebviewTextEditorInset(editor, -1, FILE_BAR_LINES, { enableScripts: true, localResourceRoots: [] });
    } catch (err) {
      this.failed(err, 'the file bar');
      return undefined;
    }
    this.created++;
    const entry: Entry = {
      inset,
      kind: 'bar',
      line: -1,
      height: FILE_BAR_LINES,
      sig: '',
      dirty: false,
      ready: false,
      disposed: false,
      buttons: false,
      summary,
      pf,
      t0: performance.now(),
      timed: false,
      since: this.pings,
      ponged: 0,
      silent: 0,
      shown: false,
    };
    inset.webview.html = renderFileBar(summary, !pf.existed);
    this.listen(editor, entry);
    return entry;
  }

  clear(editor: vscode.TextEditor): void {
    clearTimeout(this.waiting.get(editor));
    this.waiting.delete(editor);
    const entries = this.byEditor.get(editor);
    if (!entries) return;
    this.byEditor.delete(editor);
    for (const e of [...entries]) e.inset.dispose();
    this.paintPreviews(editor);
  }

  clearAll(): void {
    for (const ed of [...this.byEditor.keys()]) this.clear(ed);
  }

  private disposeAll(): void {
    this.clearAll();
  }

  dispose(): void {
    clearTimeout(this.checkTimer);
    clearInterval(this.heartbeat);
    this.disposeAll();
    this.preview.dispose();
    this.unavailableEmitter.dispose();
    this.updateEmitter.dispose();
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

/**
 * Runs in every inset. An inset is a frame of its own, so what happens over it does not reach the editor:
 * - wheel events are sent to the extension, which scrolls the editor (in lines: the inset is `rows` editor lines tall);
 * - a click that is not on a button and selects nothing hands keyboard focus back to the editor, and so does Escape.
 * It also answers the extension's pings, which is how the extension knows the inset still runs.
 */
function insetScript(rows: number): string {
  return `
addEventListener('wheel', (e) => {
  if (e.ctrlKey || !e.deltaY) return;
  // A wheel notch is 40px; deltas in lines or pages are rare
  const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
  vscode.postMessage({ cmd: 'wheel', lines: px / (innerHeight > 0 ? innerHeight / ${rows} : 18), alt: e.altKey, y: e.clientY, h: innerHeight });
}, { passive: true });
addEventListener('mouseup', (e) => {
  if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button')) || String(getSelection())) return;
  vscode.postMessage({ cmd: 'focus' });
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') vscode.postMessage({ cmd: 'focus' });
});
addEventListener('message', (e) => {
  if (e.data && e.data.cmd === 'ping') vscode.postMessage({ cmd: 'pong', n: e.data.n });
});`;
}

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
${CHANGE_BUTTON_SCRIPT}${insetScript(lines.length + (o.buttons ? 1 : 0))}
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
${CHANGE_BUTTON_SCRIPT}${insetScript(1)}
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
});${insetScript(FILE_BAR_LINES)}
vscode.postMessage({ cmd: 'ready' });
</script></body></html>`;
}
