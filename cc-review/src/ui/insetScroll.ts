// Scrolls an editor for its insets. An inset is a webview in a frame of its own, so a wheel event over
// one never reaches the editor, and VS Code does not pass it on: left alone, the editor stands still
// whenever the pointer is over deleted lines, a row of buttons or the file bar. The insets send their
// wheel events here instead. The same scrolling keeps the text in view in place when insets appear or
// disappear above it.
import * as vscode from 'vscode';
import { revealFor, type Zone } from '../core/insets';

interface State {
  /** Lines the wheel has asked for and the editor has not scrolled yet (positive = down) */
  pending: number;
  /** A scroll command is on its way to the window, since when */
  busy: boolean;
  busySince: number;
  /** Where the pointer was inside the inset at the last wheel event */
  y?: number;
  /** Scroll commands sent since the inset last moved under the pointer */
  asked: number;
  /** Wheel events in a row during which the inset did not move although the editor was told to scroll, and since when */
  stuck: number;
  stuckSince: number;
  /** Until then, scroll with revealRange: the scroll command is not reaching this editor */
  revealUntil: number;
  /** The first visible line the last revealRange should lead to, and when it was asked for */
  revealed?: { first: number; at: number };
  /** When the editor's visible range last changed */
  scrolledAt: number;
}

/** Scroll by whole lines; pixel-exact, but it acts on the editor with keyboard focus, or else the active one */
function scrollCommand(lines: number): Thenable<unknown> {
  return vscode.commands.executeCommand('editorScroll', { to: lines > 0 ? 'down' : 'up', by: 'wrappedLine', value: Math.abs(lines), revealCursor: false });
}

export class InsetScroller {
  private readonly states = new WeakMap<vscode.TextEditor, State>();

  private state(editor: vscode.TextEditor): State {
    let s = this.states.get(editor);
    if (!s) this.states.set(editor, (s = { pending: 0, busy: false, busySince: 0, asked: 0, stuck: 0, stuckSince: 0, revealUntil: 0, scrolledAt: 0 }));
    return s;
  }

  /** The editor's visible range changed */
  noteScrolled(editor: vscode.TextEditor): void {
    this.state(editor).scrolledAt = Date.now();
  }

  /**
   * A wheel event over an inset: the wheel's distance in editor `lines` (fractions add up), whether
   * Alt was held, the pointer's position `y` inside the inset and the inset's height `h` in pixels
   * (0 while it is hidden). `zones` are the editor's insets.
   */
  wheel(editor: vscode.TextEditor, lines: number, alt: boolean, y: number, h: number, zones: () => Zone[]): void {
    if (!Number.isFinite(lines) || lines === 0) return;
    const s = this.state(editor);
    const now = Date.now();
    // The editor itself scrolls 50px per 40px wheel notch, times these settings: do the same, so that scrolling
    // feels alike over an inset and beside it
    const cfg = vscode.workspace.getConfiguration('editor', editor.document);
    lines *= 1.25 * (cfg.get<number>('mouseWheelScrollSensitivity') ?? 1) * (alt ? (cfg.get<number>('fastScrollSensitivity') ?? 5) : 1);
    // Scrolling moves the inset under a pointer that stands still. If it stays put, the scroll command went
    // elsewhere: to an editor with keyboard focus that is not this one (a chat or commit message box).
    // At either end of the file nothing moves either, and that is fine
    const ranges = editor.visibleRanges;
    const atEnd = lines < 0 ? ranges[0]?.start.line === 0 : (ranges.at(-1)?.end.line ?? 0) >= editor.document.lineCount - 1;
    if (h > 0 && s.asked > 0 && y === s.y && !atEnd) {
      if (s.stuck++ === 0) s.stuckSince = now;
      if (s.stuck >= 5 && now - s.stuckSince > 250) s.revealUntil = now + 5000;
    } else {
      s.stuck = 0;
      if (y !== s.y) s.asked = 0;
    }
    s.y = y;
    s.pending += Math.max(-200, Math.min(200, lines));
    this.flush(editor, s, zones);
  }

  private flush(editor: vscode.TextEditor, s: State, zones: () => Zone[]): void {
    // A command that has not come back after a second never will
    if (s.busy && Date.now() - s.busySince < 1000) return;
    const lines = Math.trunc(s.pending);
    if (lines === 0) return;
    s.pending -= lines;
    if (vscode.window.activeTextEditor === editor && Date.now() >= s.revealUntil) {
      // One command at a time: wheel events that arrive meanwhile add up and go out together
      s.busy = true;
      s.busySince = Date.now();
      s.asked++;
      const done = () => {
        s.busy = false;
        this.flush(editor, s, zones);
      };
      scrollCommand(lines).then(done, done);
    } else {
      this.reveal(editor, s, lines, zones());
    }
  }

  /** The lines "reveal at top" leaves above the revealed line: room for sticky scroll, or your editor.cursorSurroundingLines */
  private pad(editor: vscode.TextEditor): number {
    const cfg = vscode.workspace.getConfiguration('editor', editor.document);
    const sticky = cfg.get<boolean>('stickyScroll.enabled', true) ? (cfg.get<number>('stickyScroll.maxLineCount') ?? 5) : 0;
    const ranges = editor.visibleRanges;
    const visible = ranges.length ? ranges[ranges.length - 1].end.line - ranges[0].start.line + 1 : 40;
    return Math.max(0, Math.min(Math.floor(visible / 2), Math.max(cfg.get<number>('cursorSurroundingLines') ?? 0, sticky)));
  }

  /** The editor's first visible line: as last asked for while the editor has not reported it yet, else as reported */
  private first(editor: vscode.TextEditor, s: State): number | undefined {
    if (s.revealed && Date.now() - s.revealed.at < 150) return s.revealed.first;
    return editor.visibleRanges[0]?.start.line;
  }

  private revealAt(editor: vscode.TextEditor, s: State, target: number, down: boolean, zones: readonly Zone[]): void {
    const first = this.first(editor, s);
    if (first === undefined) return;
    const r = revealFor(first, target, down, this.pad(editor), editor.document.lineCount - 1, zones);
    s.revealed = { first: r.first, at: Date.now() };
    const at = new vscode.Position(r.line, 0);
    editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.AtTop);
  }

  /** Scroll an editor the scroll command cannot reach, by revealing a line near its top */
  private reveal(editor: vscode.TextEditor, s: State, lines: number, zones: readonly Zone[]): void {
    const first = this.first(editor, s);
    if (first === undefined) return;
    // Going up, an inset right above the first visible line may be partly in view already: count all of it as in view,
    // or the view could move down instead
    const above = lines < 0 ? zones.filter((z) => z.line === first - 1).reduce((n, z) => n + z.height, 0) : 0;
    this.revealAt(editor, s, lines - above, lines > 0, zones);
  }

  /**
   * Whether `compensate` can keep the text in view in place right now. The active editor: always,
   * with the scroll command. Any other: only by putting its first visible line back at the top,
   * and that line is not known for sure while the editor is being scrolled.
   */
  canCompensate(editor: vscode.TextEditor): boolean {
    return vscode.window.activeTextEditor === editor || Date.now() - this.state(editor).scrolledAt > 150;
  }

  /**
   * Insets were added above the visible range (lines > 0) or removed there (lines < 0), which moved
   * the text in view by as many lines: scroll by the same amount so it stays where it was. `first` is
   * the first visible line before the change, `zones` the editor's insets after it.
   */
  compensate(editor: vscode.TextEditor, lines: number, first: number, zones: readonly Zone[]): void {
    if (lines === 0) return;
    const s = this.state(editor);
    if (vscode.window.activeTextEditor === editor) {
      void scrollCommand(lines);
    } else if (this.canCompensate(editor)) {
      s.revealed = { first, at: Date.now() };
      this.revealAt(editor, s, 0, false, zones);
    }
  }
}
