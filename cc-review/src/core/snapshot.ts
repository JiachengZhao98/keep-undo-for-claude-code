// Before/after snapshots for files changed by shell commands. Contents are stored once, addressed by
// SHA-1, in snapshots/objects/; snapshots/<key>.json caches each folder's file sizes, mtimes and hashes
// so that unchanged files are not read again. Node built-ins only (used by the hook).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
const OBJECT_GRACE_MS = 10 * 60_000;
const INDEX_TTL_MS = 7 * 24 * 3600_000;

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
  const idx = readJsonQuiet<FolderIndex>(indexFile(L, root));
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
  return hash ? readQuiet(objectFile(L, hash)) : undefined;
}

export function contentHash(data: Uint8Array): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

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
  try {
    // Already stored: refresh its time so cleanup does not remove it while a command still needs it
    const now = new Date();
    fs.utimesSync(obj, now, now);
  } catch {
    fs.mkdirSync(path.dirname(obj), { recursive: true });
    writeAtomic(obj, data);
  }
  return hash;
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

/** Delete stored contents no index or pending record refers to, and indexes unused for a week */
export function gcSnapshots(L: Layout, pendingRecords: readonly string[]): void {
  const keep = new Set<string>();
  const now = Date.now();
  let names: string[] = [];
  try {
    names = fs.readdirSync(L.snapshots);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(L.snapshots, name);
    try {
      if (now - fs.statSync(file).mtimeMs > INDEX_TTL_MS) {
        rmQuiet(file);
        continue;
      }
    } catch {
      continue;
    }
    for (const e of Object.values(readJsonQuiet<FolderIndex>(file)?.files ?? {})) if (e[2]) keep.add(e[2]);
  }
  for (const rec of pendingRecords) for (const m of rec.matchAll(/"([0-9a-f]{40})"/g)) keep.add(m[1]);
  const objects = path.join(L.snapshots, 'objects');
  let shards: string[] = [];
  try {
    shards = fs.readdirSync(objects);
  } catch {
    return;
  }
  for (const shard of shards) {
    let hashes: string[] = [];
    try {
      hashes = fs.readdirSync(path.join(objects, shard));
    } catch {
      continue;
    }
    for (const h of hashes) {
      if (keep.has(h)) continue;
      const f = path.join(objects, shard, h);
      try {
        if (now - fs.statSync(f).mtimeMs > OBJECT_GRACE_MS) rmQuiet(f);
      } catch {
        // Already gone
      }
    }
  }
}
