import { describe, expect, it } from 'vitest';
import { computeHunks } from '../../src/core/diff';
import { linesEqual, splitLines } from '../../src/core/text';
import { applyLineEdit, keepHunkLines, mergeUserEdit, undoHunkEdit, undoHunkLines } from '../../src/core/transforms';

const L = (s: string) => splitLines(s);

function makeRand(seed: number) {
  return (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
}

function randomPair(rand: (n: number) => number) {
  const alphabet = ['a', 'b', 'c', '', '}', 'x y'];
  const base = Array.from({ length: rand(25) + 1 }, () => alphabet[rand(alphabet.length)]);
  const cur = base.slice();
  for (let e = 0; e < rand(6) + 1; e++) {
    const pos = rand(cur.length + 1);
    const op = rand(3);
    if (op === 0) cur.splice(pos, 0, ...Array.from({ length: rand(3) + 1 }, () => alphabet[rand(alphabet.length)] + '+'));
    else if (op === 1 && cur.length > 1) cur.splice(Math.min(pos, cur.length - 1), rand(3) + 1);
    else if (pos < cur.length) cur[pos] = cur[pos] + '~';
  }
  if (cur.length === 0) cur.push('');
  return { base, cur };
}

describe('Keep / Undo transforms', () => {
  it('keeping a hunk merges only that hunk into the baseline', () => {
    const base = L('1\n2\n3\n4\n5');
    const cur = L('1\nX\n3\n4\nY\n5');
    const [h1, h2] = computeHunks(base, cur);
    const nb = keepHunkLines(base, cur, h1);
    expect(nb).toEqual(L('1\nX\n3\n4\n5'));
    const rest = computeHunks(nb, cur);
    expect(rest).toHaveLength(1);
    expect(rest[0].id).toBe(h2.id);
  });

  it('undoing a hunk restores its original lines in the document', () => {
    const base = L('1\n2\n3');
    const cur = L('1\nX\nY\n3');
    const [h] = computeHunks(base, cur);
    expect(undoHunkLines(cur, h)).toEqual(base);
  });

  it('undoHunkEdit agrees with undoHunkLines (file edges, trailing newline, CRLF)', () => {
    const cases: Array<[string, string]> = [
      ['a\nb\nc', 'a\nc'],
      ['a\nb\nc', 'b\nc'],
      ['a\nb\nc', 'a\nb'],
      ['a\nb\n', 'a\nb'],
      ['a\nb', 'a\nb\n'],
      ['a\nb', 'a\nb\nx\ny'],
      ['a', 'x\na'],
      ['', 'x\n'],
      ['x\n', ''],
      ['a\nb\nc', 'A\nb\nC'],
    ];
    for (const eol of ['\n', '\r\n']) {
      for (const [b, c] of cases) {
        const base = L(b);
        const cur = L(c);
        for (const h of computeHunks(base, cur)) {
          const edited = applyLineEdit(cur, undoHunkEdit(cur, h, eol), eol);
          expect(edited, `${JSON.stringify(b)} → ${JSON.stringify(c)}`).toEqual(undoHunkLines(cur, h));
        }
      }
    }
  });

  it('baseline and file agree after Keep / Undo in any order', () => {
    const rand = makeRand(7);
    for (let iter = 0; iter < 400; iter++) {
      let { base, cur } = randomPair(rand);
      for (let guard = 0; guard < 100; guard++) {
        const hunks = computeHunks(base, cur);
        if (hunks.length === 0) break;
        const h = hunks[rand(hunks.length)];
        if (rand(2) === 0) {
          base = keepHunkLines(base, cur, h);
        } else {
          const edited = applyLineEdit(cur, undoHunkEdit(cur, h, '\n'), '\n');
          expect(edited).toEqual(undoHunkLines(cur, h));
          cur = edited;
        }
      }
      expect(linesEqual(base, cur)).toBe(true);
    }
  });
});

describe('mergeUserEdit (auto-keep your edits)', () => {
  const base = L('a\nb\nc\nd\ne');
  const prev = L('a\nB\nc\nd\ne'); // Claude changed b to B

  it("merges edits outside hunks into the baseline and keeps Claude's hunk pending", () => {
    const next = L('a\nB\nc\nd!\ne');
    const merged = mergeUserEdit(base, prev, next)!;
    expect(merged).toEqual(L('a\nb\nc\nd!\ne'));
    const hunks = computeHunks(merged, next);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ removed: ['b'], curStart: 1, added: 1 });
  });

  it('does not merge edits inside a hunk; they become part of the pending change', () => {
    expect(mergeUserEdit(base, prev, L('a\nBB\nc\nd\ne'))).toBeUndefined();
  });

  it('treats a new line right next to a hunk as your edit', () => {
    const next = L('a\nB\nnew\nc\nd\ne');
    const merged = mergeUserEdit(base, prev, next)!;
    expect(merged).toEqual(L('a\nb\nnew\nc\nd\ne'));
    expect(computeHunks(merged, next)).toHaveLength(1);
  });

  it('keeps lines inserted where Claude deleted pending (you may be restoring them)', () => {
    const base2 = L('a\nb\nc');
    const prev2 = L('a\nc'); // Claude deleted b
    expect(mergeUserEdit(base2, prev2, L('a\nb\nc'))).toBeUndefined();
  });

  it('merges an edit to the line after a deletion at the right baseline position', () => {
    const base2 = L('a\nb\nc\nd');
    const prev2 = L('a\nc\nd'); // b was deleted
    const next2 = L('a\nc!\nd');
    const merged = mergeUserEdit(base2, prev2, next2)!;
    expect(merged).toEqual(L('a\nb\nc!\nd'));
    expect(computeHunks(merged, next2)).toEqual([expect.objectContaining({ removed: ['b'], added: 0 })]);
  });

  it("random: merging edits outside hunks leaves Claude's hunks unchanged", () => {
    const rand = makeRand(99);
    for (let iter = 0; iter < 300; iter++) {
      const { base: b, cur: p } = randomPair(rand);
      const hunksBefore = computeHunks(b, p);
      // Change one line in the equal region before the first hunk
      const first = hunksBefore[0];
      if (!first || first.curStart < 2) continue;
      const line = rand(first.curStart - 1);
      const next = p.slice();
      next[line] = next[line] + '#user';
      const merged = mergeUserEdit(b, p, next, hunksBefore);
      expect(merged).toBeDefined();
      const after = computeHunks(merged!, next);
      expect(after.map((h) => [h.removed, next.slice(h.curStart, h.curStart + h.added)])).toEqual(
        hunksBefore.map((h) => [h.removed, p.slice(h.curStart, h.curStart + h.added)]),
      );
    }
  });
});
