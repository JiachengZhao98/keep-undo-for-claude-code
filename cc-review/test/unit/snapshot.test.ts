import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureLayout, layoutOf, pathKey, type Layout } from '../../src/core/paths';
import {
  bytesWritten,
  contentHash,
  DEFAULT_CACHE_MB,
  gcSnapshots,
  loadIndex,
  readObject,
  saveIndex,
  saveSnapshotBudget,
  snapshotBudget,
  storeContent,
  type Entry,
} from '../../src/core/snapshot';

const MB = 1024 * 1024;
const MIN = 60_000;
const HOUR = 60 * MIN;

let L: Layout;
let work: string;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-snap-'));
  L = layoutOf(path.join(root, 'home'));
  ensureLayout(L);
  work = path.join(root, 'work');
  fs.mkdirSync(work);
});

const objectPath = (hash: string, compressed = false) => path.join(L.snapshots, 'objects', hash.slice(0, 2), hash + (compressed ? '.br' : ''));
const age = (file: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
};

function store(name: string, content: string | Buffer): string {
  const file = path.join(work, name);
  fs.writeFileSync(file, content);
  return storeContent(L, file, fs.statSync(file).size)!;
}

/** A stored content of `kb` KB, last touched `ageMs` ago */
function object(seed: string, kb: number, ageMs = HOUR): string {
  const hash = contentHash(Buffer.from(seed));
  const file = objectPath(hash);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(kb * 1024, 1));
  age(file, ageMs);
  return hash;
}

/** Space a stored content takes on disk, as cleanup counts it */
const onDisk = (...hashes: string[]) =>
  hashes.reduce((n, h) => {
    const st = fs.statSync(objectPath(h));
    return n + (st.blocks ? st.blocks * 512 : st.size);
  }, 0);

/** A folder index referring to `hashes`, last used `ageMs` ago */
function index(root: string, hashes: string[], ageMs: number): string {
  saveIndex(L, { root, ts: 0, files: Object.fromEntries(hashes.map((h, i) => [`f${i}`, [1, 1, h] as Entry])) });
  const file = path.join(L.snapshots, `${pathKey(root)}.json`);
  age(file, ageMs);
  return file;
}

describe('snapshot contents', () => {
  it('stores compressible content compressed and reads it back', () => {
    const text = 'export const answer = 42; // a line of source code\n'.repeat(400);
    const before = bytesWritten();
    const hash = store('a.ts', text);
    expect(fs.existsSync(objectPath(hash, true))).toBe(true);
    expect(fs.existsSync(objectPath(hash))).toBe(false);
    expect(fs.statSync(objectPath(hash, true)).size).toBeLessThan(text.length / 3);
    expect(bytesWritten() - before).toBe(fs.statSync(objectPath(hash, true)).size);
    expect(readObject(L, hash)?.toString()).toBe(text);
  });

  it('stores small and incompressible content as-is', () => {
    const random = crypto.randomBytes(8192);
    const big = store('photo.jpg', random);
    const small = store('note.txt', 'hi\n');
    for (const h of [big, small]) {
      expect(fs.existsSync(objectPath(h))).toBe(true);
      expect(fs.existsSync(objectPath(h, true))).toBe(false);
    }
    expect(readObject(L, big)?.equals(random)).toBe(true);
    expect(readObject(L, small)?.toString()).toBe('hi\n');
  });

  it('stores each content once and still reads contents stored uncompressed by older versions', () => {
    const text = 'line of an old snapshot\n'.repeat(200);
    const hash = contentHash(Buffer.from(text));
    fs.mkdirSync(path.dirname(objectPath(hash)), { recursive: true });
    fs.writeFileSync(objectPath(hash), text);
    age(objectPath(hash), HOUR);

    const before = bytesWritten();
    expect(store('old.txt', text)).toBe(hash);
    expect(bytesWritten()).toBe(before);
    expect(fs.existsSync(objectPath(hash, true))).toBe(false);
    // Storing it again refreshed its time, so cleanup leaves it alone for a while
    expect(Date.now() - fs.statSync(objectPath(hash)).mtimeMs).toBeLessThan(MIN);
    expect(readObject(L, hash)?.toString()).toBe(text);
  });

  it('marks a folder index as used when it is loaded', () => {
    const file = index('/p', [], 5 * HOUR);
    loadIndex(L, '/p');
    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(MIN);
  });
});

describe('snapshot cache cleanup', () => {
  it('drops folder indexes unused for a day, and the contents only they used', () => {
    const shared = object('shared', 8);
    const oldOnly = object('old only', 8);
    const oldIndex = index('/old', [shared, oldOnly], 25 * HOUR);
    index('/recent', [shared], 2 * HOUR);
    const [sharedSize, oldOnlySize] = [onDisk(shared), onDisk(oldOnly)];

    const r = gcSnapshots(L, 100 * MB);
    expect(fs.existsSync(oldIndex)).toBe(false);
    expect(fs.existsSync(objectPath(oldOnly))).toBe(false);
    expect(fs.existsSync(objectPath(shared))).toBe(true);
    expect(r).toEqual({ dropped: 1, freedBytes: oldOnlySize, keptBytes: sharedSize });
  });

  it('over budget, drops the least recently used folders until the rest fits', () => {
    const a = object('a', 40);
    const b = object('b', 40);
    const c = object('c', 40);
    const shared = object('shared', 8);
    const oldest = index('/a', [a, shared], 5 * HOUR);
    const middle = index('/b', [b], 3 * HOUR);
    const newest = index('/c', [c, shared], 1 * HOUR);
    const [aSize, rest] = [onDisk(a), onDisk(b, c, shared)];

    // Room for everything but /a's own content
    const r = gcSnapshots(L, rest);
    expect([oldest, middle, newest].map((f) => fs.existsSync(f))).toEqual([false, true, true]);
    expect(fs.existsSync(objectPath(a))).toBe(false);
    // Still used by /c
    expect(fs.existsSync(objectPath(shared))).toBe(true);
    expect(r).toEqual({ dropped: 1, freedBytes: aSize, keptBytes: rest });
  });

  it('never drops a folder used in the last 10 minutes, even over budget', () => {
    const a = object('a', 40);
    const inUse = index('/a', [a], 2 * MIN);
    const r = gcSnapshots(L, 1024);
    expect(fs.existsSync(inUse)).toBe(true);
    expect(fs.existsSync(objectPath(a))).toBe(true);
    expect(r.keptBytes).toBe(onDisk(a));
  });

  it('keeps contents a pending command needs and contents stored in the last 10 minutes', () => {
    const forCommand = object('before the command', 8);
    const justStored = object('stored a moment ago', 8, 1 * MIN);
    const orphan = object('nobody needs this', 8);
    fs.writeFileSync(path.join(L.staging, 'bash-tool1.json'), JSON.stringify({ ts: 0, snaps: [], files: { '/x': [1, 1, forCommand] } }));
    const [kept, orphanSize] = [onDisk(forCommand, justStored), onDisk(orphan)];

    const r = gcSnapshots(L, 100 * MB);
    expect(fs.existsSync(objectPath(forCommand))).toBe(true);
    expect(fs.existsSync(objectPath(justStored))).toBe(true);
    expect(fs.existsSync(objectPath(orphan))).toBe(false);
    expect(r).toEqual({ dropped: 0, freedBytes: orphanSize, keptBytes: kept });
  });

  it('removes temp files left by crashed writes once they are old', () => {
    const stale = path.join(L.snapshots, 'abc.json.123.x.0.tmp');
    const fresh = path.join(L.snapshots, 'def.json.456.y.0.tmp');
    fs.writeFileSync(stale, '{');
    fs.writeFileSync(fresh, '{');
    age(stale, HOUR);
    gcSnapshots(L, 100 * MB);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe('snapshot cache budget', () => {
  it('comes from config.json, defaults to 500 MB and is at least 50 MB', () => {
    expect(snapshotBudget(L)).toBe(DEFAULT_CACHE_MB * MB);
    saveSnapshotBudget(L, 200);
    expect(snapshotBudget(L)).toBe(200 * MB);
    saveSnapshotBudget(L, 10);
    expect(snapshotBudget(L)).toBe(50 * MB);
    fs.writeFileSync(L.config, '{"snapshotCacheMB":"lots"}');
    expect(snapshotBudget(L)).toBe(DEFAULT_CACHE_MB * MB);
  });

  it('keeps other values in config.json when saving', () => {
    fs.writeFileSync(L.config, '{"other":true}');
    saveSnapshotBudget(L, 300);
    expect(JSON.parse(fs.readFileSync(L.config, 'utf8'))).toEqual({ other: true, snapshotCacheMB: 300 });
  });
});
