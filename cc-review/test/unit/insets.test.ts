import { describe, expect, it } from 'vitest';
import { planInsets, previewCss, revealFor, type Place } from '../../src/core/insets';

const lines = (line: number, height: number, dirty = false): Place & { dirty?: boolean } => ({ kind: 'lines', line, height, dirty });
const buttons = (line: number): Place => ({ kind: 'buttons', line, height: 1 });

describe('planInsets', () => {
  it('keeps the insets that sit where a change needs one', () => {
    const existing = [lines(5, 2), buttons(8), lines(20, 1)];
    const wanted = [lines(5, 2), buttons(8), lines(20, 1)];
    expect(planInsets(existing, wanted)).toEqual({
      reuse: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      create: [],
      dispose: [],
    });
  });

  it('creates what is missing and disposes what nothing calls for', () => {
    const existing = [lines(5, 2), buttons(8)];
    const wanted = [buttons(8), lines(30, 4)];
    expect(planInsets(existing, wanted)).toEqual({ reuse: [[1, 0]], create: [1], dispose: [0] });
  });

  it('does not reuse an inset on another line, of another height or of another kind', () => {
    const existing = [lines(5, 2), lines(9, 3), buttons(12)];
    const wanted = [lines(6, 2), lines(9, 4), lines(12, 1)];
    expect(planInsets(existing, wanted)).toEqual({ reuse: [], create: [0, 1, 2], dispose: [0, 1, 2] });
  });

  it('never reuses an inset an edit may have moved', () => {
    const existing = [lines(5, 2, true)];
    expect(planInsets(existing, [lines(5, 2)])).toEqual({ reuse: [], create: [0], dispose: [0] });
  });

  it('uses each inset once', () => {
    const existing = [buttons(3), buttons(3)];
    expect(planInsets(existing, [buttons(3)])).toEqual({ reuse: [[0, 0]], create: [], dispose: [1] });
    expect(planInsets([buttons(3)], [buttons(3), buttons(3)])).toEqual({ reuse: [[0, 0]], create: [1], dispose: [] });
  });
});

describe('revealFor', () => {
  // VS Code's default: "at top" leaves 5 lines above the revealed line
  const PAD = 5;

  it('scrolls down by whole lines: the revealed line is 5 below the new top', () => {
    expect(revealFor(100, 3, true, PAD, 1000, [])).toEqual({ line: 108, first: 103 });
    expect(revealFor(100, 1, true, 0, 1000, [])).toEqual({ line: 101, first: 101 });
  });

  it('scrolls up by whole lines', () => {
    expect(revealFor(100, -3, false, PAD, 1000, [])).toEqual({ line: 102, first: 97 });
    expect(revealFor(100, -1, false, 0, 1000, [])).toEqual({ line: 99, first: 99 });
  });

  it('keeps the first line at the top (target 0)', () => {
    expect(revealFor(100, 0, false, PAD, 1000, [])).toEqual({ line: 105, first: 100 });
  });

  it('stops at the first and the last line', () => {
    expect(revealFor(2, -9, false, PAD, 1000, [])).toEqual({ line: 0, first: 0 });
    expect(revealFor(998, 9, true, PAD, 1000, [])).toEqual({ line: 1000, first: 995 });
  });

  it('counts the lines of insets on the way down, and never moves less than asked', () => {
    // A 3-line inset below line 102
    const zones = [{ line: 102, height: 3 }];
    // 2 rows down: line 102 at the top, which takes revealing line 104 (2 lines + 3 inset lines + 2 lines = 7 rows below line 100)
    expect(revealFor(100, 2, true, PAD, 1000, zones)).toEqual({ line: 104, first: 102 });
    // 4 rows down: the top of the view is inside the inset (its second line), so the first visible line is 103
    expect(revealFor(100, 4, true, PAD, 1000, zones)).toEqual({ line: 106, first: 103 });
  });

  it('counts the lines of insets on the way up, and never moves the other way', () => {
    // A 10-line inset below line 99, right above the first visible line. Line 99 is row -11
    const zones = [{ line: 99, height: 10 }];
    // 2 rows up, into the inset: its last 2 lines above line 100, which line 103 five rows further down gives
    expect(revealFor(100, -2, false, PAD, 1000, zones)).toEqual({ line: 103, first: 100 });
    // 8 rows up: no line sits 5 rows below that (the inset does), so the view goes on up to line 99 and 5 lines above it
    expect(revealFor(100, -8, false, PAD, 1000, zones)).toEqual({ line: 99, first: 94 });
    // 3 rows up from line 103: line 100 at the top
    expect(revealFor(103, -3, false, PAD, 1000, zones)).toEqual({ line: 105, first: 100 });
  });

  it('jumps over the part of a tall inset that no reveal can bring to the top', () => {
    // 40 lines below line 100, more than the 5 lines that revealing line 101 leaves above it
    const zones = [{ line: 100, height: 40 }];
    // One row down from line 100 at the top: the next position shows the inset's last 5 lines above line 101
    expect(revealFor(100, 1, true, PAD, 1000, zones)).toEqual({ line: 101, first: 101 });
    // One row up from line 101 at the top, with the whole inset counted as in view: line 100 and 5 lines above it
    expect(revealFor(101, -1 - 40, false, PAD, 1000, zones)).toEqual({ line: 100, first: 95 });
  });
});

describe('previewCss', () => {
  /** What a browser makes of the CSS string in `content: "..."` */
  const contentOf = (css: string): string => {
    const m = /content: "([^"]*)"/.exec(css);
    expect(m).not.toBeNull();
    return m![1].replace(/\\([0-9a-f]{1,6}) /g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
  };

  it('draws the lines below the line above the inset, or above the first line', () => {
    const css = previewCss(['a', 'b'], 4, false);
    expect(css.startsWith('none; position: absolute; left: 0; top: 100%;')).toBe(true);
    expect(previewCss(['a'], 4, true)).toContain('bottom: 100%');
    expect(css).toContain('tab-size: 4');
    expect(contentOf(css)).toBe('a\nb');
  });

  it('keeps the text of the lines, whatever characters they contain', () => {
    const lines = ['const s = "x"; // it\'s 100% {ok}', '\tif (a < b && c > d) { return `${a}\\n`; }', 'naïve café ✓ 🚀 中文', ''];
    expect(contentOf(previewCss(lines, 2, false))).toBe(lines.join('\n'));
  });

  it('leaves nothing in the lines that could end the string or add a declaration', () => {
    const hostile = ['"; } body { display: none } .x { content: "', "'; background: url(https://example.com/x) ;", '\\"; color: red; \\', '</style><script>alert(1)</script>', '*/ } @import "x"; /*'];
    const css = previewCss(hostile, 4, false);
    const m = /content: "([^"]*)"; white-space: pre; tab-size: 4; background: [^;]+; color: [^;]+; pointer-events: none$/.exec(css);
    // The string ends where it should, and what is inside is only letters, digits, spaces and escapes
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^(?:[A-Za-z0-9 ]|\\[0-9a-f]{1,6} )*$/);
    expect(contentOf(css)).toBe(hostile.join('\n'));
  });

  it('limits how much text a preview carries, and keeps one row per line', () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(100)}`);
    const text = contentOf(previewCss(long, 4, false));
    expect(text.split('\n').length).toBe(300);
    expect(text.replace(/\n/g, '').length).toBe(6000);
    expect(contentOf(previewCss(['y'.repeat(5000)], 4, false)).length).toBe(400);
  });
});
