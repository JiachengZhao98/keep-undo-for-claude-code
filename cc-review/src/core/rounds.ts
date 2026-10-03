// Rounds: everything Claude changed in response to one user message (prompt_id).
// For each file changed in a round, the hook keeps two snapshots: before the round's first write
// (.before) and after its last write (.after). UserPromptSubmit records your message. The extension
// runs a line-level blame over the snapshot chain to attribute each pending hunk to the round that
// introduced it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { diffRegions, type Hunk } from './diff';
import { readJsonQuiet, readQuiet, rmQuiet, writeAtomic } from './fsutil';
import { safeName, type Layout } from './paths';
import { decodeUtf8, splitLines } from './text';

export interface RoundMeta {
  promptId: string;
  session?: string;
  cwd?: string;
  /** Your message for this round (truncated to 500 characters) */
  prompt?: string;
  ts: number;
}

export interface RoundFileMeta {
  path: string;
  existedBefore: boolean;
  existsAfter: boolean;
  firstTs: number;
  lastTs: number;
  session?: string;
}

const PROMPT_MAX = 500;

export const roundDir = (L: Layout, promptId: string) => path.join(L.rounds, safeName(promptId));

// ---------- Writing (hook side) ----------

/** UserPromptSubmit: record this round's message */
export function recordPrompt(L: Layout, promptId: string, session: string | undefined, cwd: string | undefined, prompt: string | undefined): void {
  const dir = roundDir(L, promptId);
  fs.mkdirSync(dir, { recursive: true });
  const meta: RoundMeta = { promptId, session, cwd, prompt: prompt?.slice(0, PROMPT_MAX), ts: Date.now() };
  writeAtomic(path.join(dir, 'round.json'), JSON.stringify(meta));
}

/**
 * PostToolUse: on the round's first write to a file, store the content before the write; after
 * every write, update the content after it.
 * before: Buffer = content before the write, null = the file did not exist, undefined = unknown
 * (nothing is recorded).
 */
export function recordRoundWrite(
  L: Layout,
  promptId: string,
  key: string,
  file: string,
  before: Buffer | null | undefined,
  session: string | undefined,
  cwd: string | undefined,
): void {
  const dir = roundDir(L, promptId);
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = path.join(dir, `${key}.json`);
  const prev = readJsonQuiet<RoundFileMeta>(metaPath);
  if (!prev) {
    if (before === undefined) return;
    if (before) writeAtomic(path.join(dir, `${key}.before`), before);
  }
  const after = readQuiet(file);
  if (after) writeAtomic(path.join(dir, `${key}.after`), after);
  else rmQuiet(path.join(dir, `${key}.after`));
  const now = Date.now();
  const meta: RoundFileMeta = {
    path: file,
    existedBefore: prev ? prev.existedBefore : !!before,
    existsAfter: !!after,
    firstTs: prev?.firstTs ?? now,
    lastTs: now,
    session: session ?? prev?.session,
  };
  writeAtomic(metaPath, JSON.stringify(meta));
  // No UserPromptSubmit for this round (that hook is not installed, or a subagent): write a round.json without the message
  const roundMeta = path.join(dir, 'round.json');
  if (!fs.existsSync(roundMeta)) writeAtomic(roundMeta, JSON.stringify({ promptId, session, cwd, ts: now } satisfies RoundMeta));
}

// ---------- Reading (extension side) ----------

export interface RoundEntry {
  meta: RoundMeta;
  /** key -> metadata of that file in this round */
  files: Map<string, RoundFileMeta>;
}

export interface FileRound {
  round: RoundMeta;
  key: string;
  file: RoundFileMeta;
}

export class RoundStore {
  private rounds = new Map<string, RoundEntry>();
  private byPath = new Map<string, FileRound[]>();
  private dirty = true;
  /** Snapshot lines: .before never changes, .after changes with lastTs */
  private lineCache = new Map<string, string[] | null>();

  constructor(readonly L: Layout) {}

  /** New write events or a changed rounds directory: rebuild the index on next use */
  invalidate(): void {
    this.dirty = true;
  }

  private ensure(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.rounds.clear();
    this.byPath.clear();
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(this.L.rounds);
    } catch {
      return;
    }
    for (const d of dirs) {
      const dir = path.join(this.L.rounds, d);
      const meta = readJsonQuiet<RoundMeta>(path.join(dir, 'round.json'));
      if (!meta || typeof meta.promptId !== 'string') continue;
      const entry: RoundEntry = { meta, files: new Map() };
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith('.json') || n === 'round.json') continue;
        const f = readJsonQuiet<RoundFileMeta>(path.join(dir, n));
        if (!f || typeof f.path !== 'string') continue;
        const key = n.slice(0, -5);
        entry.files.set(key, f);
        const list = this.byPath.get(f.path) ?? [];
        list.push({ round: meta, key, file: f });
        this.byPath.set(f.path, list);
      }
      this.rounds.set(meta.promptId, entry);
    }
    for (const list of this.byPath.values()) list.sort((a, b) => a.file.firstTs - b.file.firstTs);
  }

  get(promptId: string): RoundEntry | undefined {
    this.ensure();
    return this.rounds.get(promptId);
  }

  all(): RoundEntry[] {
    this.ensure();
    return [...this.rounds.values()].sort((a, b) => b.meta.ts - a.meta.ts);
  }

  /** Rounds that changed this file, oldest first */
  forPath(p: string): FileRound[] {
    this.ensure();
    return this.byPath.get(p) ?? [];
  }

  read(promptId: string, key: string, side: 'before' | 'after'): Buffer | undefined {
    return readQuiet(path.join(roundDir(this.L, promptId), `${key}.${side}`));
  }

  /** Snapshot lines; null if the snapshot is missing or not text */
  lines(promptId: string, key: string, side: 'before' | 'after'): string[] | null {
    const b = this.read(promptId, key, side);
    const d = b && decodeUtf8(b);
    return d ? splitLines(d.text) : null;
  }

  private cachedLines(fr: FileRound, side: 'before' | 'after'): string[] | null {
    const k = `${fr.round.promptId}|${fr.key}|${side}|${side === 'after' ? fr.file.lastTs : 0}`;
    if (!this.lineCache.has(k)) {
      if (this.lineCache.size > 300) this.lineCache.clear();
      this.lineCache.set(k, this.lines(fr.round.promptId, fr.key, side));
    }
    return this.lineCache.get(k)!;
  }

  /** A file's snapshot chain (oldest first), for blame */
  chain(p: string): Snapshot[] {
    return this.forPath(p).map((fr) => ({
      roundId: fr.round.promptId,
      before: fr.file.existedBefore ? this.cachedLines(fr, 'before') : [],
      after: fr.file.existsAfter ? this.cachedLines(fr, 'after') : [],
    }));
  }

  /** Delete rounds older than 7 days, and rounds older than 1 day whose files no longer have baselines */
  gc(hasBaseline: (key: string) => boolean, now = Date.now()): number {
    this.dirty = true;
    let removed = 0;
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(this.L.rounds);
    } catch {
      return 0;
    }
    for (const d of dirs) {
      const dir = path.join(this.L.rounds, d);
      let mtime = 0;
      try {
        mtime = fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      const meta = readJsonQuiet<RoundMeta>(path.join(dir, 'round.json'));
      const age = now - Math.max(mtime, meta?.ts ?? 0);
      if (age < 24 * 3600_000) continue;
      let keys: string[] = [];
      try {
        keys = fs
          .readdirSync(dir)
          .filter((n) => n.endsWith('.json') && n !== 'round.json')
          .map((n) => n.slice(0, -5));
      } catch {
        continue;
      }
      if (age > 7 * 24 * 3600_000 || !keys.some(hasBaseline)) {
        rmQuiet(dir);
        removed++;
      }
    }
    return removed;
  }
}

// ---------- blame ----------

export interface Snapshot {
  roundId: string;
  /** Content before this round; [] if the file did not exist; null if unreadable (binary) */
  before: string[] | null;
  after: string[] | null;
}

/** For each line of b, the matching line in a (equal lines aligned by the diff), or -1 */
export function lineMap(a: readonly string[], b: readonly string[]): Int32Array {
  const map = new Int32Array(b.length).fill(-1);
  let ai = 0;
  let bi = 0;
  for (const r of diffRegions(a, b)) {
    while (bi < r.b0) map[bi++] = ai++;
    ai = r.a1;
    bi = r.b1;
  }
  while (bi < b.length) map[bi++] = ai++;
  return map;
}

/**
 * Which round introduced each current line. Walk back from the current content:
 * current -> after the last round (lines missing there were added later, e.g. your own edits)
 * -> before the last round (lines missing there were added by that round) -> after the previous
 * round -> ... Lines that survive to before the first round were there all along.
 */
export function blameLines(cur: readonly string[], chain: readonly Snapshot[]): (string | undefined)[] {
  const owner: (string | undefined)[] = new Array(cur.length).fill(undefined);
  const pos = cur.map((_, i) => i);
  const alive = cur.map(() => true);
  let version: readonly string[] = cur;
  for (let k = chain.length - 1; k >= 0; k--) {
    const s = chain[k];
    if (!s.after || !s.before) break; // Unreadable snapshot (binary): cannot trace further back
    let m = lineMap(s.after, version);
    for (let i = 0; i < cur.length; i++) {
      if (!alive[i]) continue;
      const a = m[pos[i]];
      if (a < 0) alive[i] = false;
      else pos[i] = a;
    }
    m = lineMap(s.before, s.after);
    for (let i = 0; i < cur.length; i++) {
      if (!alive[i]) continue;
      const a = m[pos[i]];
      if (a < 0) {
        owner[i] = s.roundId;
        alive[i] = false;
      } else {
        pos[i] = a;
      }
    }
    version = s.before;
  }
  return owner;
}

function countBlock(lines: readonly string[], block: readonly string[]): number {
  if (block.length === 0) return 0;
  let n = 0;
  outer: for (let i = 0; i + block.length <= lines.length; i++) {
    for (let j = 0; j < block.length; j++) if (lines[i + j] !== block[j]) continue outer;
    n++;
  }
  return n;
}

/**
 * Attribute each pending hunk to a round (roundId), or undefined if none applies.
 * Hunks with added lines: the latest round that introduced any of those lines. Pure deletions: the
 * latest round whose before-snapshot contains the removed lines more often than its after-snapshot.
 */
export function attributeHunks(hunks: readonly Hunk[], cur: readonly string[], chain: readonly Snapshot[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  if (chain.length === 0) {
    for (const h of hunks) out.set(h.id, undefined);
    return out;
  }
  const order = new Map(chain.map((s, i) => [s.roundId, i]));
  const owners = hunks.some((h) => h.added > 0) ? blameLines(cur, chain) : [];
  for (const h of hunks) {
    let best: string | undefined;
    if (h.added > 0) {
      for (let i = h.curStart; i < h.curStart + h.added; i++) {
        const o = owners[i];
        if (o !== undefined && (best === undefined || order.get(o)! > order.get(best)!)) best = o;
      }
    } else {
      for (let k = chain.length - 1; k >= 0 && best === undefined; k--) {
        const s = chain[k];
        if (s.before && s.after && countBlock(s.before, h.removed) > countBlock(s.after, h.removed)) best = s.roundId;
      }
    }
    out.set(h.id, best);
  }
  return out;
}

/** First line of the message, used as a title */
export function promptTitle(meta: RoundMeta | undefined, max = 48): string {
  const first = meta?.prompt?.split('\n').find((l) => l.trim())?.trim();
  if (!first) return '(prompt text not recorded)';
  return first.length > max ? first.slice(0, max) + '…' : first;
}
