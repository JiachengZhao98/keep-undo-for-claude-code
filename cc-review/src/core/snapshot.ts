// Before/after snapshots for files changed by shell commands. Contents are stored once, addressed by
// SHA-1 and compressed, in snapshots/objects/; snapshots/<key>.json caches each folder's file sizes,
// mtimes and hashes so that unchanged files are not read again. Node built-ins only (used by the hook).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { readJsonQuiet, readQuiet, rmQuiet, writeAtomic } from './fsutil';
import { DEFAULT_IGNORE, matchRules, parseIgnore, type IgnoreRule } from './ignore';
import { isUnder, pathKey, type Layout } from './paths';

/** size, mtime, content hash (null: content not stored because the file is too large or time ran out) */
export type Entry = [size: number, mtimeMs: number, hash: string | null];

export const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
/** Folders with more files than this are not snapshotted as a whole (CC_REVIEW_MAX_FOLDER_FILES overrides it, for tests) */
export const MAX_FOLDER_FILES = Number(process.env.CC_REVIEW_MAX_FOLDER_FILES) || 10_000;
/** A folder found too large is not walked again for this long */
const TOO_BIG_TTL_MS = 3600_000;
/** Contents and folder indexes this recent are never removed: a command may be using them */
const OBJECT_GRACE_MS = 10 * 60_000;
/** A folder index unused for this long is dropped; it only saves the next command from reading unchanged files */
const INDEX_TTL_MS = 24 * 3600_000;
/** Default disk budget of the cache (ccReview.snapshotCacheMB) */
export const DEFAULT_CACHE_MB = 500;
const MIN_CACHE_MB = 50;
const MB = 1024 * 1024;
/** Compressed contents carry this suffix; contents stored as-is (incompressible, or from older versions) have none */
const BROTLI = '.br';

/** Generated, vendored and tool folders that are not walked (a .ccreviewignore can re-include them with !name) */
export const SNAPSHOT_EXCLUDES = [
  '.git', 'node_modules', '.DS_Store', '__pycache__', '*.pyc', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.next', '.nuxt', '.turbo', '.parcel-cache', '.cache', '.gradle', '.idea', '.vscode-test', '.claude',
  'dist', 'build', 'out', 'target', 'coverage',
];

export interface FolderIndex {
  root: string;
  ts: number;
  /** When the folder was last found to have more than MAX_FOLDER_FILES files */
  tooBig?: number;
  files: Record<string, Entry>;
}

const indexFile = (L: Layout, root: string) => path.join(L.snapshots, `${pathKey(root)}.json`);
const objectFile = (L: Layout, hash: string) => path.join(L.snapshots, 'objects', hash.slice(0, 2), hash);

export function loadIndex(L: Layout, root: string): FolderIndex {
  const file = indexFile(L, root);
  // Mark it as in use, so cleanup does not drop it while this command relies on it
  touch(file);
  const idx = readJsonQuiet<FolderIndex>(file);
  return idx && idx.root === root && idx.files ? idx : { root, ts: Date.now(), files: {} };
}

export function saveIndex(L: Layout, idx: FolderIndex): void {
  idx.ts = Date.now();
  writeAtomic(indexFile(L, idx.root), JSON.stringify(idx));
}

export function isTooBig(idx: FolderIndex): boolean {
  return idx.tooBig !== undefined && Date.now() - idx.tooBig < TOO_BIG_TTL_MS;
}

export function readObject(L: Layout, hash: string | null): Buffer | undefined {
  if (!hash) return undefined;
  const obj = objectFile(L, hash);
  const packed = readQuiet(obj + BROTLI);
  if (packed) {
    try {
      return zlib.brotliDecompressSync(packed);
    } catch {
      // Damaged: fall back to a copy stored as-is, if any
    }
  }
  return readQuiet(obj);
}

export function contentHash(data: Uint8Array): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

function touch(file: string): boolean {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
    return true;
  } catch {
    return false;
  }
}

/**
 * Brotli at its fastest quality: source code shrinks to about a third at roughly 170 MB/s (gzip -1
 * compresses as well at about 100 MB/s). Undefined when it saves too little, e.g. images or archives.
 */
function compress(data: Buffer): Buffer | undefined {
  if (data.length < 512) return undefined;
  const packed = zlib.brotliCompressSync(data, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length },
  });
  return packed.length < data.length * 0.9 ? packed : undefined;
}

/** Bytes of new content this process has stored (the hook handles one command per process) */
let written = 0;
export const bytesWritten = (): number => written;

/** Copy the file into the object store; returns its hash, or null if it is too large or unreadable */
export function storeContent(L: Layout, abs: string, size: number): string | null {
  if (size > MAX_SNAPSHOT_FILE_BYTES) return null;
  let data: Buffer;
  try {
    data = fs.readFileSync(abs);
  } catch {
    return null;
  }
  const hash = contentHash(data);
  const obj = objectFile(L, hash);
  // Already stored: refresh its time so cleanup does not remove it while a command still needs it
  if (touch(obj + BROTLI) || touch(obj)) return hash;
  fs.mkdirSync(path.dirname(obj), { recursive: true });
  const packed = compress(data);
  if (packed) writeAtomic(obj + BROTLI, packed);
  else writeAtomic(obj, data);
  written += (packed ?? data).length;
  return hash;
}

/** The cache's budget in bytes: ccReview.snapshotCacheMB, which the extension saves to config.json for the hook */
export function snapshotBudget(L: Layout): number {
  const mb = readJsonQuiet<{ snapshotCacheMB?: unknown }>(L.config)?.snapshotCacheMB;
  return (typeof mb === 'number' && Number.isFinite(mb) ? Math.max(mb, MIN_CACHE_MB) : DEFAULT_CACHE_MB) * MB;
}

export function saveSnapshotBudget(L: Layout, mb: number): void {
  const config = readJsonQuiet<Record<string, unknown>>(L.config) ?? {};
  if (config.snapshotCacheMB !== mb) writeAtomic(L.config, JSON.stringify({ ...config, snapshotCacheMB: mb }));
}

/** Stat one file and store its content; undefined if it is not a regular file */
export function captureFile(L: Layout, abs: string, cached: Entry | undefined, deadline: number): Entry | undefined {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return undefined;
  }
  if (!st.isFile()) return undefined;
  if (cached && cached[0] === st.size && cached[1] === st.mtimeMs && cached[2]) return cached;
  return [st.size, st.mtimeMs, Date.now() < deadline ? storeContent(L, abs, st.size) : null];
}

/** Capture the given files of a folder (paths relative to it) and make them the folder's cached state */
export function captureFiles(L: Layout, idx: FolderIndex, rels: readonly string[], deadline: number): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (const rel of rels) {
    const e = captureFile(L, path.join(idx.root, rel), idx.files[rel], deadline);
    if (e) out[rel] = e;
  }
  idx.files = out;
  return out;
}

/** Rules for walking a folder: generated folders, the global ignore file and the nearest project .ccreviewignore above it */
export function folderRules(L: Layout, root: string): IgnoreRule[] {
  const rules = parseIgnore(SNAPSHOT_EXCLUDES.join('\n'), root);
  let global: string;
  try {
    global = fs.readFileSync(L.ignoreFile, 'utf8');
  } catch {
    global = DEFAULT_IGNORE;
  }
  rules.push(...parseIgnore(global, undefined));
  for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
    try {
      rules.push(...parseIgnore(fs.readFileSync(path.join(dir, '.ccreviewignore'), 'utf8'), dir));
      break;
    } catch {
      // Keep looking upwards
    }
    if (path.dirname(dir) === dir) break;
  }
  return rules;
}

/**
 * Every file in a folder that is not a git repository, relative to it, honoring .gitignore and
 * .ccreviewignore files on the way and skipping nested repositories (they are tracked through git).
 * Undefined if the folder has more than `cap` files or the walk takes too long.
 */
export function listFolder(L: Layout, root: string, cap = MAX_FOLDER_FILES, budgetMs = 1500): string[] | undefined {
  const rules = folderRules(L, root);
  const files: string[] = [];
  const stack = [''];
  const t0 = Date.now();
  while (stack.length) {
    const rel = stack.pop()!;
    const dir = path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const name of ['.gitignore', '.ccreviewignore']) {
      if (entries.some((e) => e.name === name && e.isFile())) {
        try {
          rules.push(...parseIgnore(fs.readFileSync(path.join(dir, name), 'utf8'), dir));
        } catch {
          // Unreadable ignore file
        }
      }
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (matchRules(rules, abs) === true || isUnder(abs, L.root)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!fs.existsSync(path.join(abs, '.git'))) stack.push(childRel);
      } else if (e.isFile()) {
        files.push(childRel);
        if (files.length > cap) return undefined;
      }
    }
    if (Date.now() - t0 > budgetMs) return undefined;
  }
  return files;
}

/** Different size or mtime, unless the stored contents show it is the same */
export function changed(before: Entry, now: Entry): boolean {
  return (before[0] !== now[0] || before[1] !== now[1]) && !(before[2] && before[2] === now[2]);
}

export interface FileChange {
  abs: string;
  /** Content before the command: Buffer, null = the file did not exist, undefined = unknown */
  before: Buffer | null | undefined;
}

/**
 * Compare a folder's files before and after a command. `nowRels` lists the files now; a file not in
 * `before` counts as created when `complete` (the before list had every file) or its mtime is after `since`.
 */
export function diffFolder(
  L: Layout,
  idx: FolderIndex,
  before: Record<string, Entry>,
  nowRels: readonly string[],
  opts: { deadline: number; complete: boolean; since: number },
): FileChange[] {
  const after = captureFiles(L, idx, nowRels, opts.deadline);
  const changes: FileChange[] = [];
  for (const [rel, e] of Object.entries(after)) {
    const abs = path.join(idx.root, rel);
    const b = before[rel];
    if (!b) {
      if (opts.complete || e[1] >= opts.since) changes.push({ abs, before: null });
    } else if (changed(b, e)) {
      changes.push({ abs, before: readObject(L, b[2]) });
    }
  }
  // Files no longer listed: deleted, or listed elsewhere now (e.g. a file the command added to git)
  for (const [rel, b] of Object.entries(before)) {
    if (rel in after) continue;
    const abs = path.join(idx.root, rel);
    const e = captureFile(L, abs, undefined, opts.deadline);
    if (e ? changed(b, e) : !fs.existsSync(abs)) changes.push({ abs, before: readObject(L, b[2]) });
  }
  return changes;
}

export interface SnapshotGc {
  /** Folder indexes dropped, unused for a day or to meet the budget */
  dropped: number;
  freedBytes: number;
  keptBytes: number;
}

const mtimeOf = (file: string): number | undefined => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;

const readDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Keep the cache within its budget. It is only a cache: a running command needs the contents its
 * record refers to, while folder indexes just spare the next command from reading unchanged files.
 * 1. Drop folder indexes unused for a day.
 * 2. While over budget, drop the least recently used index. Indexes used in the last 10 minutes stay:
 *    loading an index marks it, and a command may still rely on it.
 * 3. Delete contents that no index or pending command refers to, unless stored in the last 10
 *    minutes (a command may have stored them without saving its index yet).
 */
export function gcSnapshots(L: Layout, budget = snapshotBudget(L), now = Date.now()): SnapshotGc {
  const result: SnapshotGc = { dropped: 0, freedBytes: 0, keptBytes: 0 };
  const recent = (mtime: number) => now - mtime < OBJECT_GRACE_MS;
  /** A temp file left by a crashed write: removed once old enough */
  const leftover = (file: string): boolean => {
    if (!file.endsWith('.tmp')) return false;
    if (!recent(mtimeOf(file) ?? now)) rmQuiet(file);
    return true;
  };

  const indexes: Array<{ file: string; used: number; hashes: Set<string> }> = [];
  for (const name of readDir(L.snapshots)) {
    const file = path.join(L.snapshots, name);
    if (leftover(file) || !name.endsWith('.json')) continue;
    const used = mtimeOf(file);
    if (used === undefined) continue;
    if (now - used > INDEX_TTL_MS) {
      rmQuiet(file);
      result.dropped++;
      continue;
    }
    const hashes = new Set<string>();
    for (const e of Object.values(readJsonQuiet<FolderIndex>(file)?.files ?? {})) if (e[2]) hashes.add(e[2]);
    indexes.push({ file, used, hashes });
  }

  // Contents that pending shell commands (staging/bash-<id>.json) still need
  const pending = new Set<string>();
  for (const name of readDir(L.staging)) {
    if (!name.startsWith('bash-')) continue;
    for (const m of (readQuiet(path.join(L.staging, name))?.toString() ?? '').matchAll(/"([0-9a-f]{40})"/g)) pending.add(m[1]);
  }

  const objects = new Map<string, { files: string[]; bytes: number; recent: boolean }>();
  const objectsDir = path.join(L.snapshots, 'objects');
  for (const shard of readDir(objectsDir)) {
    for (const name of readDir(path.join(objectsDir, shard))) {
      const file = path.join(objectsDir, shard, name);
      if (leftover(file)) continue;
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (!st) continue;
      const hash = name.endsWith(BROTLI) ? name.slice(0, -BROTLI.length) : name;
      const o = objects.get(hash) ?? { files: [], bytes: 0, recent: false };
      o.files.push(file);
      // Space taken on disk: a small file still fills a whole block
      o.bytes += st.blocks ? st.blocks * 512 : st.size;
      o.recent ||= recent(st.mtimeMs);
      objects.set(hash, o);
    }
  }

  const refs = new Map<string, number>();
  for (const idx of indexes) for (const h of idx.hashes) refs.set(h, (refs.get(h) ?? 0) + 1);
  const needed = (h: string) => (refs.get(h) ?? 0) > 0 || pending.has(h) || !!objects.get(h)?.recent;
  for (const [h, o] of objects) if (needed(h)) result.keptBytes += o.bytes;

  indexes.sort((a, b) => a.used - b.used);
  for (const idx of indexes) {
    if (result.keptBytes <= budget || recent(idx.used)) break;
    // A command may have started using it since it was read
    if (mtimeOf(idx.file) !== idx.used) continue;
    rmQuiet(idx.file);
    result.dropped++;
    for (const h of idx.hashes) {
      refs.set(h, refs.get(h)! - 1);
      if (!needed(h)) result.keptBytes -= objects.get(h)?.bytes ?? 0;
    }
  }

  for (const [h, o] of objects) {
    if (needed(h)) continue;
    for (const f of o.files) rmQuiet(f);
    result.freedBytes += o.bytes;
  }
  return result;
}
