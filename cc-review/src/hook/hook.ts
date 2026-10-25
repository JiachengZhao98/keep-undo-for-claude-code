// Run by Claude Code as a child process: must be fast, always exit 0, and pre/post never write to stdout.
// Exit 0 with no output means "no decision", so the permission flow proceeds as usual.
//
//   pre        PreToolUse(Edit|Write|MultiEdit|NotebookEdit): stage the file's current content in staging/<tool_use_id>
//   post       PostToolUse(Edit|Write|MultiEdit|NotebookEdit): if there is no baseline yet, promote the staged content to one; append a write event
//   prompt     UserPromptSubmit: print this session's unreported reverts to stdout as context for Claude
//   stop       Stop: append a turn-end event, so the extension can summarize what Claude changed in this turn
//   bash-pre   PreToolUse(Bash): snapshot the folders the command may change
//   bash-post  PostToolUse(Bash): find the files the command changed and take baselines from the snapshot
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  appendJsonLine,
  copyAtomic,
  readJsonLines,
  readJsonQuiet,
  readQuiet,
  rmQuiet,
  withLock,
  writeAtomic,
} from '../core/fsutil';
import { analyzeCommand, type CommandInfo } from '../core/command';
import { ignoreMatcher, isIgnored } from '../core/ignore';
import {
  baseFile,
  canonical,
  ensureLayout,
  isUnder,
  layoutOf,
  lockDir,
  metaFile,
  pathKey,
  safeName,
  type Layout,
} from '../core/paths';
import { formatRevertReport, type RevertLine, type RevertRecord } from '../core/reverts';
import { recordPrompt, recordRoundWrite } from '../core/rounds';
import {
  bytesWritten,
  captureFile,
  captureFiles,
  changed,
  contentHash,
  diffFolder,
  gcSnapshots,
  isTooBig,
  listFolder,
  loadIndex,
  MAX_FOLDER_FILES,
  readObject,
  saveIndex,
  SNAPSHOT_EXCLUDES,
  snapshotBudget,
  type Entry,
  type FileChange,
} from '../core/snapshot';
import { contentEqual } from '../core/text';

interface HookInput {
  session_id?: string;
  prompt_id?: string;
  agent_id?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

interface StagedMeta {
  path: string;
  existed: boolean;
  ts: number;
}

interface BaselineMeta {
  path: string;
  existed: boolean;
  ts: number;
  sessions?: string[];
}

const MAX_BASELINE_BYTES = 20 * 1024 * 1024;
const STAGING_TTL_MS = 6 * 3600_000;
const MAX_LOG_BYTES = 1024 * 1024;

void main();

async function main(): Promise<void> {
  const mode = process.argv[2] ?? '';
  const L = layoutOf();
  try {
    const raw = await readStdin();
    const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
    ensureLayout(L);
    // Debugging: record the raw input from Claude Code (off by default)
    if (process.env.CC_REVIEW_DEBUG) fs.appendFileSync(path.join(L.root, 'hook-debug.jsonl'), JSON.stringify({ mode, input }) + '\n');
    if (mode === 'pre') pre(L, input);
    else if (mode === 'post') post(L, input);
    else if (mode === 'prompt') prompt(L, input);
    else if (mode === 'stop') appendJsonLine(L.events, { type: 'turn-end', session: input.session_id, prompt: input.prompt_id, ts: Date.now() });
    else if (mode === 'bash-pre') bashPre(L, input);
    else if (mode === 'bash-post') bashPost(L, input);
    else log(L, mode, `unknown mode`);
  } catch (e) {
    log(L, mode, e instanceof Error ? (e.stack ?? e.message) : String(e));
  }
  process.exitCode = 0;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, 5000);
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function log(L: Layout, mode: string, msg: string): void {
  try {
    try {
      if (fs.statSync(L.hookLog).size > MAX_LOG_BYTES) fs.truncateSync(L.hookLog, 0);
    } catch {
      // The log does not exist yet
    }
    fs.mkdirSync(L.root, { recursive: true });
    fs.appendFileSync(L.hookLog, `${new Date().toISOString()} [${mode}] ${msg}\n`);
  } catch {
    // If even logging fails, give up: never disturb Claude Code
  }
}

function filePathOf(input: HookInput): string | undefined {
  const fp = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof fp !== 'string' || !fp) return undefined;
  return path.isAbsolute(fp) ? fp : path.resolve(input.cwd || process.cwd(), fp);
}

function stagingId(input: HookInput, key: string): string {
  return input.tool_use_id ? safeName(input.tool_use_id) : `${key}-${safeName(input.session_id || 'nosession')}`;
}

function pre(L: Layout, input: HookInput): void {
  const file = filePathOf(input);
  if (!file) return;
  const p = canonical(file);
  if (isIgnored(p, L.ignoreFile, L.root)) return;
  const id = stagingId(input, pathKey(p));
  // Always stage, even when a baseline exists: the extension may delete an equal baseline while the permission prompt is open
  let existed = false;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return;
    if (st.size > MAX_BASELINE_BYTES) {
      log(L, 'pre', `skip large file ${p} (${st.size} bytes)`);
      return;
    }
    copyAtomic(p, path.join(L.staging, `${id}.base`));
    existed = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const meta: StagedMeta = { path: p, existed, ts: Date.now() };
  writeAtomic(path.join(L.staging, `${id}.json`), JSON.stringify(meta));
}

/**
 * The original content from tool_response, when Claude Code provides it: the content right after
 * permission was granted and right before the write.
 * string = original content, null = new file, undefined = unknown.
 */
function originalFromResponse(resp: unknown): string | null | undefined {
  if (!resp || typeof resp !== 'object') return undefined;
  const r = resp as Record<string, unknown>;
  if (typeof r.originalFile === 'string') return r.originalFile;
  if (r.type === 'create') return null;
  return undefined;
}

function addSession(L: Layout, key: string, session: string | undefined): void {
  if (!session) return;
  const meta = readJsonQuiet<BaselineMeta>(metaFile(L, key));
  if (!meta) return;
  const sessions = meta.sessions ?? [];
  if (sessions.includes(session)) return;
  meta.sessions = [...sessions, session];
  writeAtomic(metaFile(L, key), JSON.stringify(meta));
}

function post(L: Layout, input: HookInput): void {
  const file = filePathOf(input);
  if (!file) return;
  const p = canonical(file);
  const key = pathKey(p);
  const id = stagingId(input, key);
  const stMeta = path.join(L.staging, `${id}.json`);
  const stBase = path.join(L.staging, `${id}.base`);
  if (isIgnored(p, L.ignoreFile, L.root)) {
    rmQuiet(stMeta);
    rmQuiet(stBase);
    return;
  }
  const staged = readJsonQuiet<StagedMeta>(stMeta);
  const original = originalFromResponse(input.tool_response);
  const stagedBytes = staged?.existed ? readQuiet(stBase) : undefined;
  // Content before this write: Buffer, null = did not exist, undefined = unknown.
  // Use the staged copy (byte-exact) when it matches Claude Code's original content or none was given;
  // a mismatch means the file changed during the permission prompt, so trust the content from right before the write.
  const stagedOk =
    !!staged &&
    (original === undefined ||
      (original === null ? !staged.existed : !!stagedBytes && contentEqual(stagedBytes, Buffer.from(original, 'utf8'))));
  const before: Buffer | null | undefined = stagedOk
    ? staged!.existed
      ? stagedBytes
      : null
    : typeof original === 'string'
      ? Buffer.from(original, 'utf8')
      : original === null
        ? null
        : undefined;

  withLock(lockDir(L, key), () => {
    if (fs.existsSync(metaFile(L, key))) {
      // A baseline already exists: keep the first-touch content, just record that this session edited the file too
      addSession(L, key, input.session_id);
    } else if (before === undefined) {
      log(L, 'post', `no staged baseline for ${p}`);
    } else {
      if (before) writeAtomic(baseFile(L, key), before);
      else rmQuiet(baseFile(L, key));
      const meta: BaselineMeta = {
        path: p,
        existed: before !== null,
        ts: staged?.ts ?? Date.now(),
        sessions: input.session_id ? [input.session_id] : [],
      };
      writeAtomic(metaFile(L, key), JSON.stringify(meta)); // Metadata is written last; the extension treats it as the source of truth
    }
    if (input.prompt_id) recordRoundWrite(L, input.prompt_id, key, p, before, input.session_id, input.cwd);
  });

  rmQuiet(stMeta);
  rmQuiet(stBase);
  appendEvent(L, input, p, input.tool_name);
  if (Math.random() < 0.05) gcStaging(L);
}

function appendEvent(L: Layout, input: HookInput, p: string, tool: string | undefined): void {
  appendJsonLine(L.events, {
    type: 'claude-write',
    path: p,
    tool,
    session: input.session_id,
    prompt: input.prompt_id,
    agent: input.agent_id,
    toolUseId: input.tool_use_id,
    ts: Date.now(),
  });
}

function gcStaging(L: Layout): void {
  const now = Date.now();
  for (const name of fs.readdirSync(L.staging)) {
    const f = path.join(L.staging, name);
    try {
      if (now - fs.statSync(f).mtimeMs > STAGING_TTL_MS) rmQuiet(f);
    } catch {
      // May have been deleted by another process
    }
  }
}

function prompt(L: Layout, input: HookInput): void {
  if (input.prompt_id) recordPrompt(L, input.prompt_id, input.session_id, input.cwd, input.prompt);
  const session = input.session_id;
  if (!session) return;
  const lines = readJsonLines<RevertLine>(L.reverts);
  if (lines.length === 0) return;
  const cancelled = new Set(lines.filter((l) => l.type === 'cancel').map((l) => l.id));
  const reportedFile = path.join(L.reported, `${safeName(session)}.json`);
  const reported = new Set(readJsonQuiet<string[]>(reportedFile) ?? []);
  const cwd = input.cwd ? canonical(input.cwd) : undefined;
  const mine = lines.filter(
    (l): l is RevertRecord =>
      l.type === 'revert' &&
      !cancelled.has(l.id) &&
      !reported.has(l.id) &&
      (l.sessions?.length ? l.sessions.includes(session) : !!cwd && isUnder(l.path, cwd)),
  );
  if (mine.length === 0) return;
  // Mark as reported before printing: better to miss a report once than to repeat it on every message
  for (const r of mine) reported.add(r.id);
  writeAtomic(reportedFile, JSON.stringify([...reported]));
  fs.writeSync(1, formatRevertReport(mine, cwd));
}

// ---------- Bash ----------
// A shell command can change any file, so the folders it may touch are snapshotted before it runs and
// compared afterwards: the starting directory, the project directory, every `cd` target and every path
// the command mentions. Inside a git repository, committed files come from `git stash create` and only
// untracked files are copied; other folders are copied as a whole (up to MAX_FOLDER_FILES files), and
// for larger ones only the files the command mentions are tracked.

/** One folder's state before a command */
type FolderSnap =
  | { kind: 'git'; dir: string; ref: string | null; untracked: Record<string, Entry>; complete: boolean }
  | { kind: 'dir'; dir: string; files: Record<string, Entry> };

interface BashRecord {
  ts: number;
  snaps: FolderSnap[];
  /** Files the command mentions outside those folders: their state before, or null if they did not exist */
  files: Record<string, Entry | null>;
  /** Bytes of new content the snapshot added to the cache */
  written?: number;
}

const MAX_FOLDERS = 6;
const MAX_UNTRACKED = 5000;
const BASH_BUDGET_MS = 4000;

function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).replace(/\n$/, '');
  } catch {
    return undefined;
  }
}

function gitBytes(cwd: string, args: string[]): Buffer | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: MAX_BASELINE_BYTES,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch {
    return undefined;
  }
}

function gitTop(dir: string): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return undefined;
  }
}

/** Untracked files git does not ignore (all files, when the repository has no commit to compare with) */
function gitFiles(top: string, all: boolean, ignored: (p: string) => boolean): string[] | undefined {
  const args = ['ls-files', '-z', ...(all ? ['--cached'] : []), '--others', '--exclude-standard', ...SNAPSHOT_EXCLUDES.map((x) => `--exclude=${x}`)];
  const out = git(top, args, 64 * 1024 * 1024);
  return out?.split('\0').filter((r) => r && !ignored(path.join(top, r)));
}

/** Which folders to snapshot for a command, and the files it mentions outside git repositories */
function bashTargets(info: CommandInfo, ignored: (p: string) => boolean): { repos: string[]; folders: string[]; files: string[] } {
  const repos = new Set<string>();
  const folders = new Set<string>();
  const files: string[] = [];
  const project = process.env.CLAUDE_PROJECT_DIR;
  for (const d of project ? [...info.dirs, project] : info.dirs) {
    const dir = canonical(d);
    const top = gitTop(dir);
    if (top) repos.add(top);
    else if (fs.existsSync(dir) && !ignored(dir)) folders.add(dir);
  }
  for (const p of info.paths) {
    const abs = canonical(p);
    const top = gitTop(abs);
    if (top) repos.add(top);
    else if (ignored(abs)) continue;
    else if (fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) folders.add(abs);
    else files.push(abs);
  }
  return { repos: [...repos].slice(0, MAX_FOLDERS), folders: [...folders].slice(0, MAX_FOLDERS), files };
}

function bashRecordFile(L: Layout, input: HookInput): string {
  return path.join(L.staging, `bash-${safeName(input.tool_use_id ?? '')}.json`);
}

function bashPre(L: Layout, input: HookInput): void {
  const command = input.tool_input?.command;
  if (!input.tool_use_id || typeof command !== 'string') return;
  const info = analyzeCommand(command, input.cwd || process.cwd());
  if (info.readOnly) return;
  const deadline = Date.now() + BASH_BUDGET_MS;
  const ignored = ignoreMatcher(L.ignoreFile, L.root);
  const targets = bashTargets(info, ignored);
  const record: BashRecord = { ts: Date.now(), snaps: [], files: {} };
  for (const top of targets.repos) {
    // With uncommitted changes, stash create returns a snapshot commit; with a clean tree it prints nothing, so use HEAD
    const ref = git(top, ['stash', 'create']) || git(top, ['rev-parse', '--verify', '-q', 'HEAD']) || null;
    const rels = gitFiles(top, !ref, ignored);
    if (!rels) continue;
    const idx = loadIndex(L, top);
    const untracked = captureFiles(L, idx, rels.slice(0, MAX_UNTRACKED), deadline);
    saveIndex(L, idx);
    record.snaps.push({ kind: 'git', dir: top, ref, untracked, complete: rels.length <= MAX_UNTRACKED });
  }
  const walked: string[] = [];
  for (const dir of targets.folders) {
    const idx = loadIndex(L, dir);
    if (isTooBig(idx)) continue;
    const rels = listFolder(L, dir);
    if (!rels) {
      idx.tooBig = Date.now();
      idx.files = {};
      saveIndex(L, idx);
      log(L, 'bash-pre', `${dir} has more than ${MAX_FOLDER_FILES} files: only files a command names are tracked there`);
      continue;
    }
    delete idx.tooBig;
    const files = captureFiles(L, idx, rels, deadline);
    saveIndex(L, idx);
    record.snaps.push({ kind: 'dir', dir, files });
    walked.push(dir);
  }
  for (const f of targets.files) {
    if (!walked.some((d) => isUnder(f, d))) record.files[f] = captureFile(L, f, undefined, deadline) ?? null;
  }
  record.written = bytesWritten();
  if (record.snaps.length || Object.keys(record.files).length) writeAtomic(bashRecordFile(L, input), JSON.stringify(record));
}

function bashPost(L: Layout, input: HookInput): void {
  if (!input.tool_use_id) return;
  const recFile = bashRecordFile(L, input);
  const record = readJsonQuiet<BashRecord>(recFile);
  if (!record) return;
  const deadline = Date.now() + BASH_BUDGET_MS;
  const ignored = ignoreMatcher(L.ignoreFile, L.root);
  const changes = new Map<string, Buffer | null | undefined>();
  const add = (c: FileChange) => {
    if (!changes.has(c.abs)) changes.set(c.abs, c.before);
  };
  for (const s of record.snaps) {
    const idx = loadIndex(L, s.dir);
    if (s.kind === 'git') {
      const tracked = s.ref ? (git(s.dir, ['diff', '--name-only', '--no-renames', '-z', s.ref]) ?? '').split('\0').filter(Boolean) : [];
      for (const rel of tracked) {
        // A file that was untracked before (and added to git by the command) is compared with its copy below
        if (rel in s.untracked) continue;
        const original = gitBytes(s.dir, ['show', `${s.ref}:${rel}`]);
        const inTree = original !== undefined || git(s.dir, ['cat-file', '-t', `${s.ref}:${rel}`]) === 'blob';
        add({ abs: path.join(s.dir, rel), before: original ?? (inTree ? undefined : null) });
      }
      const rels = gitFiles(s.dir, !s.ref, ignored);
      if (rels) for (const c of diffFolder(L, idx, s.untracked, rels.slice(0, MAX_UNTRACKED), { deadline, complete: s.complete, since: record.ts })) add(c);
    } else {
      const rels = listFolder(L, s.dir) ?? Object.keys(s.files);
      for (const c of diffFolder(L, idx, s.files, rels, { deadline, complete: true, since: record.ts })) add(c);
    }
    saveIndex(L, idx);
  }
  for (const [abs, b] of Object.entries(record.files)) {
    const now = captureFile(L, abs, undefined, deadline);
    if (b === null ? now : now ? changed(b, now) : !fs.existsSync(abs)) add({ abs, before: b === null ? null : readObject(L, b[2]) });
  }
  rmQuiet(recFile);
  const saves = userSavesSince(L, record.ts - 2000);
  for (const [abs, before] of changes) recordBashChange(L, input, canonical(abs), before, record.ts, saves, ignored);
  // Trim the cache now and then, and right away when this command added a lot to it
  const budget = snapshotBudget(L);
  if (Math.random() < 0.05 || (record.written ?? 0) + bytesWritten() > budget / 20) gcSnapshots(L, budget);
}

/** Content hashes of files saved in VS Code since `since`, per path: those changes are the user's, not Claude's */
function userSavesSince(L: Layout, since: number): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const s of readJsonLines<{ path?: string; ts?: number; hash?: string }>(L.userSaves)) {
    if (!s?.path || !s.hash || (s.ts ?? 0) < since) continue;
    const set = out.get(s.path) ?? new Set<string>();
    set.add(s.hash);
    out.set(s.path, set);
  }
  return out;
}

function recordBashChange(
  L: Layout,
  input: HookInput,
  p: string,
  before: Buffer | null | undefined,
  ts: number,
  saves: Map<string, Set<string>>,
  ignored: (p: string) => boolean,
): void {
  if (ignored(p)) return;
  if (before === undefined) {
    log(L, 'bash-post', `${p} changed, but its earlier content is unknown (too large or not captured in time)`);
    return;
  }
  const size = fs.statSync(p, { throwIfNoEntry: false })?.size;
  if (before === null && size === undefined) return; // Created and removed again
  const now = size !== undefined && size <= MAX_BASELINE_BYTES ? readQuiet(p) : undefined;
  if (before && now && contentEqual(before, now)) return;
  if (now && saves.get(p)?.has(contentHash(now))) return;
  const key = pathKey(p);
  withLock(lockDir(L, key), () => {
    if (fs.existsSync(metaFile(L, key))) {
      addSession(L, key, input.session_id);
    } else {
      if (before) writeAtomic(baseFile(L, key), before);
      else rmQuiet(baseFile(L, key));
      const meta: BaselineMeta = { path: p, existed: before !== null, ts, sessions: input.session_id ? [input.session_id] : [] };
      writeAtomic(metaFile(L, key), JSON.stringify(meta));
    }
    if (input.prompt_id) recordRoundWrite(L, input.prompt_id, key, p, before, input.session_id, input.cwd);
  });
  appendEvent(L, input, p, 'Bash');
}
