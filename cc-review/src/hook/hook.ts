// Run by Claude Code as a child process: must be fast, always exit 0, and pre/post never write to stdout.
// Exit 0 with no output means "no decision", so the permission flow proceeds as usual.
//
//   pre        PreToolUse(Edit|Write): stage the file's current content in staging/<tool_use_id>
//   post       PostToolUse(Edit|Write): if there is no baseline yet, promote the staged content to one; append a write event
//   prompt     UserPromptSubmit: print this session's unreported reverts to stdout as context for Claude
//   bash-pre   PreToolUse(Bash), optional: snapshot with git stash create
//   bash-post  PostToolUse(Bash), optional: find files the command changed and take baselines from the snapshot
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
import { isIgnored } from '../core/ignore';
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

interface BashSnapshot {
  repo: string;
  ref: string;
  untracked: string[];
  ts: number;
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
  const fp = input.tool_input?.file_path;
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

// ---------- Bash (optional) ----------

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

function bashPre(L: Layout, input: HookInput): void {
  if (!input.cwd || !input.tool_use_id) return;
  const top = git(input.cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return;
  // With uncommitted changes, stash create returns a snapshot commit; with a clean tree it prints nothing, so use HEAD
  const ref = git(top, ['stash', 'create']) || git(top, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!ref) return;
  const untracked = (git(top, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '').split('\0').filter(Boolean);
  const snap: BashSnapshot = { repo: canonical(top), ref, untracked, ts: Date.now() };
  writeAtomic(path.join(L.staging, `bash-${safeName(input.tool_use_id)}.json`), JSON.stringify(snap));
}

/** Whether this path exists in the snapshot commit */
function inTree(snap: BashSnapshot, rel: string): boolean {
  return git(snap.repo, ['cat-file', '-t', `${snap.ref}:${rel}`]) === 'blob';
}

function bashPost(L: Layout, input: HookInput): void {
  if (!input.tool_use_id) return;
  const snapFile = path.join(L.staging, `bash-${safeName(input.tool_use_id)}.json`);
  const snap = readJsonQuiet<BashSnapshot>(snapFile);
  rmQuiet(snapFile);
  if (!snap) return;
  const changed = (git(snap.repo, ['diff', '--name-only', '--no-renames', '-z', snap.ref]) ?? '').split('\0').filter(Boolean);
  const before = new Set(snap.untracked);
  const created = (git(snap.repo, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '')
    .split('\0')
    .filter((f) => f && !before.has(f));
  const todo: Array<[string, boolean]> = [...changed.map((r): [string, boolean] => [r, false]), ...created.map((r): [string, boolean] => [r, true])];
  for (const [rel, isNew] of todo) {
    const p = canonical(path.join(snap.repo, rel));
    if (isIgnored(p, L.ignoreFile, L.root)) continue;
    const key = pathKey(p);
    // `changed` holds tracked files present in the snapshot (pre-command content comes from it); `created`
    // holds untracked files the command created. A tracked file missing from the snapshot (added with
    // git add during the command) also counts as new.
    const original = isNew ? null : (gitBytes(snap.repo, ['show', `${snap.ref}:${rel}`]) ?? (inTree(snap, rel) ? undefined : null));
    if (original === undefined) {
      log(L, 'bash-post', `cannot read ${rel} from ${snap.ref}`);
      continue;
    }
    withLock(lockDir(L, key), () => {
      if (fs.existsSync(metaFile(L, key))) {
        addSession(L, key, input.session_id);
      } else {
        if (original) writeAtomic(baseFile(L, key), original);
        else rmQuiet(baseFile(L, key));
        const meta: BaselineMeta = { path: p, existed: !!original, ts: snap.ts, sessions: input.session_id ? [input.session_id] : [] };
        writeAtomic(metaFile(L, key), JSON.stringify(meta));
      }
      if (input.prompt_id) recordRoundWrite(L, input.prompt_id, key, p, original, input.session_id, input.cwd);
    });
    appendEvent(L, input, p, 'Bash');
  }
}
