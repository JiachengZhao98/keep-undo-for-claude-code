import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeHunks } from '../../src/core/diff';
import { layoutOf, pathKey, type Layout } from '../../src/core/paths';
import { attributeHunks, blameLines, lineMap, promptTitle, recordPrompt, recordRoundWrite, RoundStore, type Snapshot } from '../../src/core/rounds';
import { splitLines } from '../../src/core/text';

const L_ = (s: string) => splitLines(s);
const snap = (roundId: string, before: string | null, after: string | null): Snapshot => ({
  roundId,
  before: before === null ? [] : L_(before),
  after: after === null ? [] : L_(after),
});

describe('lineMap', () => {
  it('maps equal lines one to one and changed lines to -1', () => {
    expect([...lineMap(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])]).toEqual([0, -1, 2, -1]);
    expect([...lineMap([], ['a'])]).toEqual([-1]);
  });
});

describe('blameLines: which round added each line', () => {
  it('two rounds add one line each', () => {
    const chain = [snap('r1', 'a\nb\nc', 'a\nX\nb\nc'), snap('r2', 'a\nX\nb\nc', 'a\nX\nb\nY\nc')];
    expect(blameLines(L_('a\nX\nb\nY\nc'), chain)).toEqual([undefined, 'r1', undefined, 'r2', undefined]);
  });

  it("lines you added between rounds or after the last round are not Claude's", () => {
    const chain = [snap('r1', 'a\nb\nc', 'a\nX\nb\nc'), snap('r2', 'a\nX\nU\nb\nc', 'a\nX\nU\nb\nY\nc')];
    expect(blameLines(L_('a\nX\nU\nb\nY\nc\nZ'), chain)).toEqual([undefined, 'r1', undefined, undefined, 'r2', undefined, undefined]);
  });

  it('a line added in one round and changed in a later one belongs to the later round', () => {
    const chain = [snap('r1', 'a\nb', 'a\nfoo()\nb'), snap('r2', 'a\nfoo()\nb', 'a\nfoo(1)\nb')];
    expect(blameLines(L_('a\nfoo(1)\nb'), chain)).toEqual([undefined, 'r2', undefined]);
  });

  it('a file created in a round belongs entirely to that round', () => {
    expect(blameLines(L_('x\ny'), [snap('r1', null, 'x\ny')])).toEqual(['r1', 'r1']);
  });

  it('stops tracing at an unreadable (binary) snapshot', () => {
    const chain: Snapshot[] = [{ roundId: 'r1', before: null, after: L_('a\nX') }, snap('r2', 'a\nX', 'a\nX\nY')];
    expect(blameLines(L_('a\nX\nY'), chain)).toEqual([undefined, undefined, 'r2']);
  });
});

describe('attributeHunks: which round each pending hunk belongs to', () => {
  it('attributes by added lines; pure deletions by the round that removed the lines', () => {
    const base = L_('a\nb\nc\nd\ne');
    const after1 = 'a\nX\nb\nc\nd\ne';
    const after2 = 'a\nX\nb\nc\ne\nY';
    const chain = [snap('r1', 'a\nb\nc\nd\ne', after1), snap('r2', after1, after2)];
    const cur = L_(after2);
    const hunks = computeHunks(base, cur);
    expect(hunks.map((h) => [h.removed, h.added])).toEqual([
      [[], 1],
      [['d'], 0],
      [[], 1],
    ]);
    const attr = attributeHunks(hunks, cur, chain);
    expect(hunks.map((h) => attr.get(h.id))).toEqual(['r1', 'r2', 'r2']);
  });

  it('a hunk mixing two rounds belongs to the later one', () => {
    const chain = [snap('r1', 'a\nb', 'a\nX1\nb'), snap('r2', 'a\nX1\nb', 'a\nX1\nX2\nb')];
    const cur = L_('a\nX1\nX2\nb');
    const hunks = computeHunks(L_('a\nb'), cur);
    expect(hunks).toHaveLength(1);
    expect(attributeHunks(hunks, cur, chain).get(hunks[0].id)).toBe('r2');
  });

  it('attributes nothing without snapshots', () => {
    const cur = L_('a\nX');
    const hunks = computeHunks(L_('a'), cur);
    expect(attributeHunks(hunks, cur, []).get(hunks[0].id)).toBeUndefined();
  });
});

describe('RoundStore: round snapshots written by the hook', () => {
  let home: string;
  let L: Layout;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-rounds-'));
    L = layoutOf(home);
    fs.mkdirSync(L.rounds, { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('records messages and before/after snapshots and chains them by time', async () => {
    const file = path.join(home, 'a.ts');
    const key = pathKey(file);
    recordPrompt(L, 'p1', 's1', home, 'Change b to B\nsecond line');
    fs.writeFileSync(file, 'a\nB\n');
    recordRoundWrite(L, 'p1', key, file, Buffer.from('a\nb\n'), 's1', home);
    fs.writeFileSync(file, 'a\nB\nc\n');
    recordRoundWrite(L, 'p1', key, file, Buffer.from('a\nB\n'), 's1', home); // Second write in the same round: before stays the same
    await new Promise((r) => setTimeout(r, 5));
    recordPrompt(L, 'p2', 's1', home, 'x'.repeat(600));
    fs.writeFileSync(file, 'a\nB\nc\nd\n');
    recordRoundWrite(L, 'p2', key, file, Buffer.from('a\nB\nc\n'), 's1', home);

    const store = new RoundStore(L);
    expect(store.all().map((r) => r.meta.promptId)).toEqual(['p2', 'p1']);
    expect(store.get('p1')!.meta.prompt).toBe('Change b to B\nsecond line');
    expect(store.get('p2')!.meta.prompt).toHaveLength(500);
    expect(promptTitle(store.get('p1')!.meta)).toBe('Change b to B');
    expect(store.forPath(file).map((r) => r.round.promptId)).toEqual(['p1', 'p2']);
    const chain = store.chain(file);
    expect(chain[0]).toEqual({ roundId: 'p1', before: ['a', 'b', ''], after: ['a', 'B', 'c', ''] });
    expect(chain[1]).toEqual({ roundId: 'p2', before: ['a', 'B', 'c', ''], after: ['a', 'B', 'c', 'd', ''] });
    const owners = blameLines(L_('a\nB\nc\nd\n'), chain);
    expect(owners).toEqual([undefined, 'p1', 'p1', 'p2', undefined]);
  });

  it('new file: existedBefore is false and there is no .before', () => {
    const file = path.join(home, 'new.ts');
    fs.writeFileSync(file, 'x\n');
    recordRoundWrite(L, 'p1', pathKey(file), file, null, 's1', home);
    const store = new RoundStore(L);
    const [fr] = store.forPath(file);
    expect(fr.file.existedBefore).toBe(false);
    expect(store.read('p1', pathKey(file), 'before')).toBeUndefined();
    expect(store.chain(file)[0].before).toEqual([]);
    // round.json exists even without UserPromptSubmit
    expect(fr.round.prompt).toBeUndefined();
    expect(promptTitle(fr.round)).toBe('(prompt text not recorded)');
  });

  it('records nothing when the previous content is unknown', () => {
    const file = path.join(home, 'u.ts');
    fs.writeFileSync(file, 'x');
    recordRoundWrite(L, 'p1', pathKey(file), file, undefined, 's1', home);
    expect(new RoundStore(L).forPath(file)).toEqual([]);
  });

  it('gc deletes rounds older than 7 days and fully reviewed rounds older than 1 day, keeps pending ones', () => {
    const file = path.join(home, 'a.ts');
    const stillPending = path.join(home, 'b.ts');
    fs.writeFileSync(file, 'x');
    fs.writeFileSync(stillPending, 'x');
    for (const id of ['old', 'done', 'fresh']) recordRoundWrite(L, id, pathKey(file), file, Buffer.from('y'), 's', home);
    recordRoundWrite(L, 'pending', pathKey(stillPending), stillPending, Buffer.from('y'), 's', home);
    const store = new RoundStore(L);
    const day = 24 * 3600_000;
    const age = (id: string, ms: number) => {
      const dir = path.join(L.rounds, id);
      const t = new Date(Date.now() - ms);
      fs.writeFileSync(path.join(dir, 'round.json'), JSON.stringify({ promptId: id, ts: Date.now() - ms }));
      fs.utimesSync(dir, t, t);
    };
    age('old', 8 * day);
    age('done', 2 * day);
    age('pending', 2 * day);
    const removed = store.gc((key) => key === pathKey(stillPending));
    expect(removed).toBe(2);
    expect(fs.readdirSync(L.rounds).sort()).toEqual(['fresh', 'pending']);
  });
});
