// The parts of inset management that need no editor: which insets can stay when a file's changes
// change, how to scroll an editor with TextEditor.revealRange, and the preview drawn while an inset starts.

/** Where an inset sits. An inset cannot be moved or resized once created, only reused where it is. */
export interface Place {
  kind: string;
  /** The inset sits below this line (0-based; -1 = above the first line) */
  line: number;
  /** Height in editor lines */
  height: number;
}

export interface InsetPlan {
  /** [index in existing, index in wanted]: the existing inset already sits where the wanted one goes */
  reuse: Array<[number, number]>;
  /** Indexes in wanted that need a new inset */
  create: number[];
  /** Indexes in existing that nothing calls for any more */
  dispose: number[];
}

/**
 * Match the insets an editor has with the ones its changes call for, by place rather than by change:
 * a change keeps its place when Claude or you edit inside it, although its id changes with its content.
 * An inset marked dirty may have been moved by the edit that touched its line, so it is never reused.
 */
export function planInsets(existing: ReadonlyArray<Place & { dirty?: boolean }>, wanted: readonly Place[]): InsetPlan {
  const key = (p: Place) => `${p.kind}:${p.line}:${p.height}`;
  const free = new Map<string, number>();
  existing.forEach((e, i) => {
    if (!e.dirty && !free.has(key(e))) free.set(key(e), i);
  });
  const plan: InsetPlan = { reuse: [], create: [], dispose: [] };
  wanted.forEach((w, j) => {
    const i = free.get(key(w));
    if (i === undefined) {
      plan.create.push(j);
    } else {
      free.delete(key(w));
      plan.reuse.push([i, j]);
    }
  });
  const kept = new Set(plan.reuse.map(([i]) => i));
  existing.forEach((_, i) => {
    if (!kept.has(i)) plan.dispose.push(i);
  });
  return plan;
}

/** An inset as far as scrolling goes: the line it sits below, and its height in lines */
export interface Zone {
  line: number;
  height: number;
}

export interface Reveal {
  /** The line to pass to revealRange with TextEditorRevealType.AtTop */
  line: number;
  /** The first visible line after that, as far as the known insets tell */
  first: number;
}

/**
 * How to scroll an editor with TextEditor.revealRange, the only way to scroll one that is not active.
 * "At top" puts a line `pad` lines below the top (VS Code keeps room there for sticky scroll), and
 * every inset above that line pushes it down, so not every position can be reached.
 *
 * Rows count lines and inset lines alike, from the top of `first`, the first visible line. The
 * result is the line whose reveal puts the top of the view at row `target`, or else the nearest
 * position beyond it: further down when `down`, further up otherwise. A wheel turn therefore always
 * moves the view, and never the wrong way; past a tall inset it can move more than asked.
 */
export function revealFor(first: number, target: number, down: boolean, pad: number, lastLine: number, zones: readonly Zone[]): Reveal {
  const below = new Map<number, number>();
  for (const z of zones) below.set(z.line, (below.get(z.line) ?? 0) + z.height);
  const after = (line: number) => below.get(line) ?? 0;
  let line = Math.max(0, Math.min(first, lastLine));
  // The row of `line`. Revealing it puts the top of the view at row - pad
  let row = 0;
  const forward = () => {
    row += 1 + after(line);
    line++;
  };
  const back = () => {
    line--;
    row -= 1 + after(line);
  };
  if (down) {
    while (line < lastLine && row - pad < target) forward();
  } else {
    while (line > 0 && row - pad > target) back();
    while (line < lastLine && row + 1 + after(line) - pad <= target) forward();
  }
  // Which line is at the top then: walk up from the revealed line by `pad` rows
  let top = line;
  let rows = 0;
  while (top > 0 && rows < pad) {
    top--;
    rows += 1 + after(top);
  }
  // Went past: the top of the view is inside the inset below that line
  if (rows > pad) top++;
  return { line, first: top };
}

/** The longest preview: lines past this many characters in total are left empty, and no line shows more than MAX_PREVIEW_LINE */
const MAX_PREVIEW_CHARS = 6000;
const MAX_PREVIEW_LINE = 400;

/**
 * CSS that draws deleted lines in the place of an inset while its webview is still starting, as the
 * content of a pseudo-element on the line above the inset (`above`: on the line below it, for an
 * inset before the first line). VS Code copies a decoration's textDecoration value into a style
 * rule as it is, so further declarations can follow the value. The lines are file content: every
 * character other than letters, digits and spaces is written as a CSS escape, so nothing in them can
 * end the string or the declaration.
 */
export function previewCss(lines: readonly string[], tabSize: number, above: boolean): string {
  let left = MAX_PREVIEW_CHARS;
  const content = lines
    .map((line) => {
      const shown = [...line].slice(0, Math.min(MAX_PREVIEW_LINE, left));
      left -= shown.length;
      return shown.map((ch) => (/^[A-Za-z0-9 ]$/.test(ch) ? ch : `\\${ch.codePointAt(0)!.toString(16)} `)).join('');
    })
    .join('\\a ');
  return [
    'none',
    'position: absolute',
    'left: 0',
    `${above ? 'bottom' : 'top'}: 100%`,
    'min-width: 100vw',
    'width: max-content',
    `content: "${content}"`,
    'white-space: pre',
    `tab-size: ${Math.max(1, Math.trunc(tabSize) || 4)}`,
    'background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.2))',
    'color: var(--vscode-editor-foreground)',
    'pointer-events: none',
  ].join('; ');
}
