// End-to-end ReviewModel logic without VS Code or Claude: write baselines and edit files directly.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewModel, type DocState, type EditApplier, type TextSource } from '../../src/core/model';
import { canonical, layoutOf, pathKey, metaFile, baseFile } from '../../src/core/paths';
import type { RevertRecord } from '../../src/core/reverts';
import { Store } from '../../src/core/store';
import { decodeUtf8, detectEol, splitLines } from '../../src/core/text';
import { applyLineEdit, type LineEdit } from '../../src/core/transforms';

/** Files on disk act as "documents"; the version increments on every write */
class DiskDocs implements TextSource, EditApplier {
  versions = new Map<string, number>();
  async read(p: string): Promise<DocState | undefined> {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(p);
    } catch {
      return undefined;
    }
    const d = decodeUtf8(buf);
    return d ? { kind: 'text', text: d.text, eol: detectEol(d.text), version: this.versions.get(p) ?? 1 } : { kind: 'binary', bytes: buf };
  }
  isOpen(): boolean {
    return false;
  }
  write(p: string, text: string | Buffer) {
    fs.writeFileSync(p, text);
    this.versions.set(p, (this.versions.get(p) ?? 1) + 1);
  }
  async applyEdits(p: string, edits: LineEdit[], expected: number | undefined): Promise<boolean> {
    if (expected !== undefined && expected !== (this.versions.get(p) ?? 1)) return false;
    const text = fs.readFileSync(p, 'utf8');
    const eol = detectEol(text);
    // Like a WorkspaceEdit: all edits refer to the same original version, so apply them bottom-up
    let lines = splitLines(text);
    for (const e of [...edits].sort((a, b) => b.startLine - a.startLine || b.startChar - a.startChar)) lines = applyLineEdit(lines, e, eol);
    this.write(p, lines.join(eol));
    return true;
  }
  async replaceAll(p: string, text: string): Promise<boolean> {
    this.write(p, text);
    return true;
  }
  async writeBytes(p: string, bytes: Buffer): Promise<void> {
    this.write(p, bytes);
  }
  async deleteFile(p: string): Promise<void> {
    fs.rmSync(p);
  }
}

let home: string;
let proj: string;
let store: Store;
let docs: DiskDocs;
let model: ReviewModel;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-model-'));
  proj = canonical(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-proj-')));
  store = new Store(layoutOf(home));
  store.ensure();
  docs = new DiskDocs();
  model = new ReviewModel(store, docs, docs, { maxBytes: 1024 * 1024 });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

/** Simulate the hook: store a baseline, then "Claude" writes new content */
function claudeWrites(name: string, before: string | undefined, after: string): string {
  const p = path.join(proj, name);
  store.write({ path: p, existed: before !== undefined, ts: Date.now(), sessions: ['s1'] }, Buffer.from(before ?? ''));
  if (before !== undefined && !fs.existsSync(p)) fs.writeFileSync(p, before);
  docs.write(p, after);
  return p;
}

const reverts = () => store.readReverts().filter((r): r is RevertRecord => r.type === 'revert');
const hasBaseline = (p: string) => fs.existsSync(metaFile(store.L, pathKey(p)));

describe('ReviewModel', () => {
  it('keeps hunk by hunk; after the last one the file leaves the queue and the baseline is deleted', async () => {
    const p = claudeWrites('a.ts', '1\n2\n3\n4\n5\n', '1\nX\n3\n4\nY\n5\n');
    const pf = (await model.refresh(p))!;
    expect(pf.hunks).toHaveLength(2);
    expect(await model.keepHunk(p, pf.hunks[1].id)).toBe('ok');
    expect(model.getFile(p)!.hunks).toHaveLength(1);
    expect(fs.readFileSync(baseFile(store.L, pathKey(p)), 'utf8')).toBe('1\n2\n3\n4\nY\n5\n');
    expect(await model.keepHunk(p, pf.hunks[0].id)).toBe('ok');
    expect(model.getFile(p)).toBeUndefined();
    expect(hasBaseline(p)).toBe(false);
    expect(fs.readFileSync(p, 'utf8')).toBe('1\nX\n3\n4\nY\n5\n');
  });

  it('undoes hunk by hunk, restoring the file and writing revert records', async () => {
    const p = claudeWrites('a.ts', 'a\nb\nc\n', 'a\nB1\nB2\nc\nnew\n');
    const [h1, h2] = (await model.refresh(p))!.hunks;
    expect(await model.undoHunk(p, h1.id)).toBe('ok');
    expect(fs.readFileSync(p, 'utf8')).toBe('a\nb\nc\nnew\n');
    expect(await model.undoHunk(p, h2.id)).toBe('ok');
    expect(fs.readFileSync(p, 'utf8')).toBe('a\nb\nc\n');
    expect(model.getFile(p)).toBeUndefined();
    expect(hasBaseline(p)).toBe(false);
    const [r1, r2] = reverts();
    expect(r1).toMatchObject({ kind: 'modified', startLine: 2, endLine: 2, undone: ['B1', 'B2'], restored: ['b'], sessions: ['s1'] });
    expect(r2).toMatchObject({ kind: 'added', startLine: 4, undone: ['new'], count: 1 });
  });

  it('keeps CRLF after undoing in a CRLF file', async () => {
    const p = claudeWrites('w.txt', 'a\r\nb\r\nc\r\n', 'a\r\nX\r\nc\r\n');
    const [h] = (await model.refresh(p))!.hunks;
    await model.undoHunk(p, h.id);
    expect(fs.readFileSync(p, 'utf8')).toBe('a\r\nb\r\nc\r\n');
  });

  it('gives up when the document version changed (staleness guard)', async () => {
    const p = claudeWrites('a.ts', 'a\nb\n', 'a\nB\n');
    const pf = (await model.refresh(p))!;
    const stale = new ReviewModel(store, docs, {
      ...docs,
      applyEdits: (q: string, e: LineEdit[]) => docs.applyEdits(q, e, -1),
      replaceAll: docs.replaceAll.bind(docs),
      writeBytes: docs.writeBytes.bind(docs),
      deleteFile: docs.deleteFile.bind(docs),
    }, { maxBytes: 1 << 20 });
    expect(await stale.undoHunk(p, pf.hunks[0].id)).toBe('stale');
    expect(await model.undoHunk(p, 'no-such-hunk')).toBe('stale');
  });

  it('new file from Claude: keeping its hunk keeps the whole file', async () => {
    const p = claudeWrites('new.ts', undefined, 'hello\nworld\n');
    const pf = (await model.refresh(p))!;
    expect(pf.existed).toBe(false);
    expect(pf.hunks).toEqual([expect.objectContaining({ curStart: 0, added: 3, removed: [] })]);
    expect(await model.keepHunk(p, pf.hunks[0].id)).toBe('ok');
    expect(model.getFile(p)).toBeUndefined();
    expect(hasBaseline(p)).toBe(false);
  });

  it('new file from Claude: undo is a file operation (delete); hunk undo returns needs-file-op', async () => {
    const p = claudeWrites('new.ts', undefined, 'x\n');
    const pf = (await model.refresh(p))!;
    expect(await model.undoHunk(p, pf.hunks[0].id)).toBe('needs-file-op');
    expect(await model.undoFile(p)).toBe('ok');
    expect(fs.existsSync(p)).toBe(false);
    expect(model.getFile(p)).toBeUndefined();
    expect(hasBaseline(p)).toBe(false);
    expect(reverts()[0]).toMatchObject({ kind: 'newfile' });
  });

  it('deleted file: Undo restores it, Keep accepts the deletion', async () => {
    const p = claudeWrites('gone.ts', 'keep me\n', 'x');
    fs.rmSync(p);
    expect((await model.refresh(p))!.missing).toBe(true);
    await model.undoFile(p);
    expect(fs.readFileSync(p, 'utf8')).toBe('keep me\n');
    expect(model.getFile(p)).toBeUndefined();

    const q = claudeWrites('gone2.ts', 'y\n', 'z');
    fs.rmSync(q);
    await model.refresh(q);
    await model.keepFile(q);
    expect(model.getFile(q)).toBeUndefined();
    expect(hasBaseline(q)).toBe(false);
  });

  it('drops the file after an external revert (git checkout / rewind)', async () => {
    const p = claudeWrites('a.ts', 'orig\n', 'claude\n');
    await model.refresh(p);
    docs.write(p, 'orig\n');
    await model.checkDisk();
    expect(model.getFile(p)).toBeUndefined();
    expect(hasBaseline(p)).toBe(false);
  });

  it('reconciles with baselines/: drops ones other windows deleted, adds ones the hook created', async () => {
    const p = claudeWrites('a.ts', 'a\n', 'b\n');
    await model.syncWithStore();
    expect(model.getFile(p)).toBeDefined();
    store.delete(pathKey(p));
    const q = claudeWrites('b.ts', 'c\n', 'd\n');
    await model.syncWithStore();
    expect(model.getFile(p)).toBeUndefined();
    expect(model.getFile(q)).toBeDefined();
  });

  it('handles binary files only as a whole', async () => {
    const p = path.join(proj, 'img.bin');
    store.write({ path: p, existed: true, ts: Date.now() }, Buffer.from([0, 1, 2]));
    docs.write(p, Buffer.from([0, 9, 9]));
    const pf = (await model.refresh(p))!;
    expect(pf.kind).toBe('binary');
    expect(await model.undoHunk(p, 'x')).toBe('needs-file-op');
    await model.undoFile(p);
    expect([...fs.readFileSync(p)]).toEqual([0, 1, 2]);
    expect(model.getFile(p)).toBeUndefined();
  });

  it('skips hunks for large files and keeps them as a whole', async () => {
    const small = new ReviewModel(store, docs, docs, { maxBytes: 10 });
    const p = claudeWrites('big.txt', 'line one\nline two\n', 'line one\nline 2\n');
    expect((await small.refresh(p))!.kind).toBe('large');
    await small.keepFile(p);
    expect(small.getFile(p)).toBeUndefined();
  });

  it('cancels the revert record when the Undo is undone with ⌘Z', async () => {
    const p = claudeWrites('a.ts', 'a\nb\nc\nd\n', 'a\nB\nc\nD\n');
    const [h] = (await model.refresh(p))!.hunks;
    await model.undoHunk(p, h.id);
    expect(fs.readFileSync(p, 'utf8')).toBe('a\nb\nc\nD\n');
    docs.write(p, 'a\nB\nc\nD\n'); // ⌘Z brings Claude's change back
    await model.refresh(p);
    const lines = store.readReverts();
    expect(lines.map((l) => l.type)).toEqual(['revert', 'cancel']);
    expect(lines[1].id).toBe(lines[0].id);
  });

  it('rebuilds the deleted baseline when the last Undo is undone, so the change is pending again', async () => {
    const p = claudeWrites('a.ts', 'a\nb\n', 'a\nB\n');
    const [h] = (await model.refresh(p))!.hunks;
    await model.undoHunk(p, h.id);
    expect(hasBaseline(p)).toBe(false);
    const undone = fs.readFileSync(p, 'utf8');
    docs.write(p, 'a\nB\n'); // ⌘Z
    expect(model.restoreBaseline(p, undone)).toBe(true);
    const pf = (await model.refresh(p))!;
    expect(pf.hunks).toEqual([expect.objectContaining({ id: h.id, removed: ['b'] })]);
    expect(pf.sessions).toEqual(['s1']);
    expect(store.readReverts().map((l) => l.type)).toEqual(['revert', 'cancel']);
    // No rebuild when a baseline exists, and no baseline out of thin air for a file never reviewed
    expect(model.restoreBaseline(p, 'x')).toBe(false);
    expect(model.restoreBaseline(path.join(proj, 'other.ts'), 'x')).toBe(false);
  });

  it('auto-keep merges edits outside hunks into the baseline on disk', async () => {
    const p = claudeWrites('a.ts', 'a\nb\nc\nd\n', 'a\nB\nc\nd\n');
    const pf = (await model.refresh(p))!;
    const prev = pf.curLines;
    const next = ['a', 'B', 'c', 'd!', ''];
    expect(model.applyUserEdit(p, prev, next)).toBe(true);
    expect(fs.readFileSync(baseFile(store.L, pathKey(p)), 'utf8')).toBe('a\nb\nc\nd!\n');
    docs.write(p, next.join('\n'));
    const after = (await model.refresh(p))!;
    expect(after.hunks).toHaveLength(1);
    expect(after.hunks[0].removed).toEqual(['b']);
    // Edits inside a hunk are not merged
    expect(model.applyUserEdit(p, after.curLines, ['a', 'BB', 'c', 'd!', ''])).toBe(false);
  });

  it('does not treat a UTF-8 BOM as a change', async () => {
    const p = path.join(proj, 'bom.txt');
    store.write({ path: p, existed: true, ts: Date.now() }, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\nb\n')]));
    docs.write(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\nB\n')]));
    const [h] = (await model.refresh(p))!.hunks;
    expect(h.removed).toEqual(['b']);
    await model.keepHunk(p, h.id);
    expect(model.getFile(p)).toBeUndefined();
  });

  it('keepHunks / undoHunks handle several hunks of a file at once; Undo writes once', async () => {
    const p = claudeWrites('multi.ts', '1\n2\n3\n4\n5\n6\n7\n', '1\nA\n3\nB\n5\nC\n7\n');
    const pf = (await model.refresh(p))!;
    expect(pf.hunks).toHaveLength(3);
    expect(await model.keepHunks(p, [pf.hunks[0].id, pf.hunks[2].id])).toBe('ok');
    expect(fs.readFileSync(baseFile(store.L, pathKey(p)), 'utf8')).toBe('1\nA\n3\n4\n5\nC\n7\n');
    expect(model.getFile(p)!.hunks.map((h) => h.id)).toEqual([pf.hunks[1].id]);

    const q = claudeWrites('multi2.ts', '1\n2\n3\n4\n5\n', '1\nA\n3\nB\n5\n');
    const pq = (await model.refresh(q))!;
    const v0 = docs.versions.get(q)!;
    expect(await model.undoHunks(q, pq.hunks.map((h) => h.id))).toBe('ok');
    expect(fs.readFileSync(q, 'utf8')).toBe('1\n2\n3\n4\n5\n');
    expect(docs.versions.get(q)).toBe(v0 + 1);
    expect(reverts().filter((r) => r.path === q)).toHaveLength(2);
    expect(model.getFile(q)).toBeUndefined();
    // If any hunk is missing, the whole operation is abandoned
    const r = claudeWrites('multi3.ts', 'a\nb\n', 'A\nb\n');
    const pr = (await model.refresh(r))!;
    expect(await model.undoHunks(r, [pr.hunks[0].id, 'missing'])).toBe('stale');
    expect(fs.readFileSync(r, 'utf8')).toBe('A\nb\n');
  });

  it('latestSession returns the session that last wrote the file', async () => {
    const p = claudeWrites('s.ts', 'a\n', 'b\n');
    model.noteEvents([
      { type: 'claude-write', path: p, session: 'old', ts: 1 },
      { type: 'claude-write', path: p, session: 'new', ts: 2 },
    ]);
    expect(model.latestSession(p)).toBe('new');
  });

  it('dump prints a readable queue', async () => {
    const p = claudeWrites('a.ts', 'a\n', 'b\n');
    await model.refresh(p);
    expect(model.dump()).toContain('a.ts');
    expect(model.dump()).toMatch(/cur@1 \+1/);
  });
});
