// Layout of ~/.cc-review and path canonicalization. Shared by the hook and the extension; Node built-ins only.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Layout {
  root: string;
  baselines: string; // <key>.json metadata + <key>.base baseline content
  staging: string; // Original content staged by PreToolUse; promoted to a baseline on PostToolUse
  reported: string; // <session>.json: reverts already reported to that session
  rounds: string; // <prompt_id>/: before/after snapshots of each file changed in that round (one user message)
  events: string; // Appended by the hook: one line per Claude write
  reverts: string; // Appended by the extension: one line per Undo
  hookLog: string;
  hookScript: string;
  ignoreFile: string;
}

export function reviewRoot(): string {
  return process.env.CC_REVIEW_HOME || path.join(os.homedir(), '.cc-review');
}

export function layoutOf(root = reviewRoot()): Layout {
  return {
    root,
    baselines: path.join(root, 'baselines'),
    staging: path.join(root, 'staging'),
    reported: path.join(root, 'reported'),
    rounds: path.join(root, 'rounds'),
    events: path.join(root, 'events.jsonl'),
    reverts: path.join(root, 'reverts.jsonl'),
    hookLog: path.join(root, 'hook.log'),
    hookScript: path.join(root, 'hook.js'),
    ignoreFile: path.join(root, '.ccreviewignore'),
  };
}

export function ensureLayout(L: Layout): void {
  for (const dir of [L.root, L.baselines, L.staging, L.reported, L.rounds]) fs.mkdirSync(dir, { recursive: true });
}

export function pathKey(p: string): string {
  return crypto.createHash('sha1').update(p).digest('hex');
}

export const metaFile = (L: Layout, key: string) => path.join(L.baselines, `${key}.json`);
export const baseFile = (L: Layout, key: string) => path.join(L.baselines, `${key}.base`);
export const lockDir = (L: Layout, key: string) => path.join(L.baselines, `${key}.lock`);

/**
 * realpath that resolves symlinks and macOS case (only the native variant normalizes case).
 * For a path that does not exist yet, resolve the nearest existing ancestor and append the rest.
 */
export function canonical(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    // Keep walking up
  }
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = path.dirname(cur);
    rest.unshift(path.basename(cur));
    if (parent === cur) return abs;
    try {
      return path.join(fs.realpathSync.native(parent), ...rest);
    } catch {
      cur = parent;
    }
  }
}

export function isUnder(child: string, dir: string): boolean {
  const rel = path.relative(dir, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 200);
}
