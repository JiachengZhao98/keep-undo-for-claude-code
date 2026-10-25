// Feeds crafted JSON to hook.js on stdin and asserts on the files in the store. CC_REVIEW_HOME points at a temp dir.
import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layoutOf, metaFile, baseFile, pathKey, canonical } from '../../src/core/paths';

const HOOK = path.resolve(__dirname, '../../dist/hook.js');

let home: string;
let proj: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-home-'));
  proj = canonical(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-proj-')));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

function run(mode: string, input: unknown, env: Record<string, string> = {}): { stdout: string; status: number | null; ms: number } {
  const t = Date.now();
  const r = spawnSync(process.execPath, [HOOK, mode], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', CC_REVIEW_HOME: home, ...env },
    encoding: 'utf8',
  });
  return { stdout: r.stdout, status: r.status, ms: Date.now() - t };
}

const L = () => layoutOf(home);
const meta = (p: string) => JSON.parse(fs.readFileSync(metaFile(L(), pathKey(p)), 'utf8'));
const base = (p: string) => fs.readFileSync(baseFile(L(), pathKey(p)), 'utf8');
const hasBaseline = (p: string) => fs.existsSync(metaFile(L(), pathKey(p)));

function edit(file: string, content: string, id: string, session = 's1', extra: object = {}) {
  const input = { session_id: session, cwd: proj, tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: file }, prompt_id: 'p1', ...extra };
  expect(run('pre', input).status).toBe(0);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  expect(run('post', { ...input, ...extra }).status).toBe(0);
}

describe('hook pre/post', () => {
  it('stores the original content as the baseline on first edit and records a write event', () => {
    const f = path.join(proj, 'a.ts');
    fs.writeFileSync(f, 'original\n');
    edit(f, 'changed\n', 'toolu_1');
    expect(meta(f)).toMatchObject({ path: f, existed: true, sessions: ['s1'] });
    expect(base(f)).toBe('original\n');
    const events = fs.readFileSync(L().events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events).toEqual([expect.objectContaining({ type: 'claude-write', path: f, session: 's1', prompt: 'p1', tool: 'Edit', toolUseId: 'toolu_1' })]);
    expect(fs.readdirSync(L().staging)).toEqual([]);
  });

  it('keeps the first-touch baseline across rounds and records new sessions', () => {
    const f = path.join(proj, 'a.ts');
    fs.writeFileSync(f, 'v0');
    edit(f, 'v1', 't1');
    edit(f, 'v2', 't2', 's2');
    expect(base(f)).toBe('v0');
    expect(meta(f).sessions).toEqual(['s1', 's2']);
  });

  it('leaves no baseline when Pre runs without Post (permission denied)', () => {
    const f = path.join(proj, 'a.ts');
    fs.writeFileSync(f, 'v0');
    run('pre', { session_id: 's1', tool_name: 'Edit', tool_use_id: 'denied', tool_input: { file_path: f } });
    expect(hasBaseline(f)).toBe(false);
  });

  it('records new files as existed: false without a .base', () => {
    const f = path.join(proj, 'sub/dir/new.ts');
    edit(f, 'hello', 't1');
    expect(meta(f)).toMatchObject({ existed: false });
    expect(fs.existsSync(baseFile(L(), pathKey(f)))).toBe(false);
  });

  it('trusts tool_response.originalFile when the file changed during the permission prompt', () => {
    const f = path.join(proj, 'a.ts');
    fs.writeFileSync(f, 'v0');
    const input = { session_id: 's1', tool_name: 'Edit', tool_use_id: 't1', tool_input: { file_path: f } };
    run('pre', input);
    fs.writeFileSync(f, 'v0 edited by user');
    fs.writeFileSync(f, 'claude');
    run('post', { ...input, tool_response: { filePath: f, originalFile: 'v0 edited by user' } });
    expect(base(f)).toBe('v0 edited by user');
  });

  it('keeps the byte-exact staged copy when it differs from originalFile only in line endings', () => {
    const f = path.join(proj, 'a.ts');
    fs.writeFileSync(f, 'a\r\nb\r\n');
    const input = { session_id: 's1', tool_name: 'Edit', tool_use_id: 't1', tool_input: { file_path: f } };
    run('pre', input);
    fs.writeFileSync(f, 'a\r\nB\r\n');
    run('post', { ...input, tool_response: { originalFile: 'a\nb\n' } });
    expect(base(f)).toBe('a\r\nb\r\n');
  });

  it('still gets a baseline when the extension deleted an equal one during the permission prompt', () => {
    const f = path.join(proj, 'a.ts');
    fs.writeFileSync(f, 'v0');
    edit(f, 'v1', 't1');
    // Second edit: Pre has run; while the permission prompt is open you undo everything and the extension deletes the baseline
    const input = { session_id: 's1', tool_name: 'Edit', tool_use_id: 't2', tool_input: { file_path: f } };
    run('pre', input);
    fs.writeFileSync(f, 'v0');
    fs.rmSync(metaFile(L(), pathKey(f)));
    fs.rmSync(baseFile(L(), pathKey(f)));
    fs.writeFileSync(f, 'v2');
    run('post', { ...input, tool_response: { originalFile: 'v0' } });
    expect(base(f)).toBe('v0');
  });

  it('never reads files listed in .ccreviewignore', () => {
    const f = path.join(proj, '.env');
    fs.writeFileSync(f, 'SECRET=1');
    edit(f, 'SECRET=2', 't1');
    expect(hasBaseline(f)).toBe(false);
    expect(fs.readdirSync(L().staging)).toEqual([]);
  });

  it('honors a project .ccreviewignore', () => {
    fs.writeFileSync(path.join(proj, '.ccreviewignore'), 'generated/\n');
    const f = path.join(proj, 'generated/out.ts');
    fs.mkdirSync(path.dirname(f));
    fs.writeFileSync(f, 'x');
    edit(f, 'y', 't1');
    expect(hasBaseline(f)).toBe(false);
  });

  it('exits 0 on bad input, prints nothing and logs to hook.log', () => {
    const r = run('pre', '{not json');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.readFileSync(L().hookLog, 'utf8')).toContain('[pre]');
  });

  it('ignores tool calls without file_path', () => {
    expect(run('pre', { tool_name: 'Edit', tool_input: {} }).status).toBe(0);
    expect(run('post', { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/x.ipynb' } }).status).toBe(0);
  });

  it('pre/post print nothing and run fast', () => {
    const f = path.join(proj, 'a.ts');
    fs.writeFileSync(f, 'v0');
    const input = { session_id: 's1', tool_name: 'Edit', tool_use_id: 't1', tool_input: { file_path: f } };
    const a = run('pre', input);
    const b = run('post', input);
    expect(a.stdout + b.stdout).toBe('');
    expect(a.ms).toBeLessThan(1500);
  });
});

describe('hook gc', () => {
  it('trims the snapshot cache and prints the result for the extension', () => {
    fs.mkdirSync(L().snapshots, { recursive: true });
    const stale = path.join(L().snapshots, `${'0'.repeat(40)}.json`);
    fs.writeFileSync(stale, JSON.stringify({ root: '/gone', ts: 0, files: {} }));
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
    const r = run('gc', '');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ dropped: 1, freedBytes: 0, keptBytes: 0 });
    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe('hook stop', () => {
  it('appends a turn-end event and prints nothing', () => {
    fs.mkdirSync(home, { recursive: true });
    const r = run('stop', { session_id: 's1', prompt_id: 'p1', hook_event_name: 'Stop', stop_hook_active: false });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const events = fs.readFileSync(L().events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.at(-1)).toEqual({ type: 'turn-end', session: 's1', prompt: 'p1', ts: expect.any(Number) });
  });
});

describe('hook prompt', () => {
  const revert = (id: string, p: string, sessions: string[], extra: object = {}) =>
    JSON.stringify({ type: 'revert', id, path: p, kind: 'modified', startLine: 3, endLine: 4, undone: ['bad()'], sessions, ts: 1, ...extra });

  it('reports unreported reverts for the session as facts, exactly once', () => {
    const p = path.join(proj, 'src/page.ts');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(L().reverts, [revert('r1', p, ['s1']), revert('r2', p, ['other'])].join('\n') + '\n');
    const first = run('prompt', { session_id: 's1', cwd: proj, prompt: 'continue' });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('src/page.ts lines 3–4: the user reverted your edit');
    expect(first.stdout).toContain('bad()');
    expect(first.stdout.match(/^- /gm)).toHaveLength(1);
    expect(run('prompt', { session_id: 's1', cwd: proj }).stdout).toBe('');
    // Another session only sees its own
    expect(run('prompt', { session_id: 'other', cwd: proj }).stdout).toContain('src/page.ts');
  });

  it('skips cancelled reverts (an Undo that was undone with ⌘Z)', () => {
    const p = path.join(proj, 'a.ts');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(L().reverts, [revert('r1', p, ['s1']), JSON.stringify({ type: 'cancel', id: 'r1', ts: 2 })].join('\n') + '\n');
    expect(run('prompt', { session_id: 's1', cwd: proj }).stdout).toBe('');
  });

  it('matches reverts without sessions by cwd', () => {
    const p = path.join(proj, 'a.ts');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(L().reverts, revert('r1', p, []) + '\n');
    expect(run('prompt', { session_id: 'x', cwd: '/somewhere/else' }).stdout).toBe('');
    expect(run('prompt', { session_id: 'y', cwd: proj }).stdout).toContain('a.ts');
  });
});

describe('hook bash', () => {
  const bash = (command: string, cwd: string, change: () => void, opts: { id?: string; env?: Record<string, string> } = {}) => {
    const input = { session_id: 's1', prompt_id: 'p1', cwd, tool_name: 'Bash', tool_use_id: opts.id ?? 'b1', tool_input: { command } };
    expect(run('bash-pre', input, opts.env).status).toBe(0);
    change();
    expect(run('bash-post', input, opts.env).status).toBe(0);
  };
  const gitInit = (dir: string) => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    return git;
  };
  const events = () => fs.readFileSync(L().events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('captures what a command changed, created or deleted in a git repo, including untracked files', () => {
    const git = gitInit(proj);
    fs.writeFileSync(path.join(proj, 'tracked.txt'), 'committed\n');
    fs.writeFileSync(path.join(proj, 'gone.txt'), 'bye\n');
    fs.writeFileSync(path.join(proj, '.gitignore'), 'dist/\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    fs.writeFileSync(path.join(proj, 'tracked.txt'), 'dirty before command\n');
    fs.writeFileSync(path.join(proj, 'old-untracked.txt'), 'u\n');

    bash('./update.sh', proj, () => {
      fs.writeFileSync(path.join(proj, 'tracked.txt'), 'changed by command\n');
      fs.writeFileSync(path.join(proj, 'created.txt'), 'new\n');
      fs.writeFileSync(path.join(proj, 'old-untracked.txt'), 'u2\n');
      fs.rmSync(path.join(proj, 'gone.txt'));
      fs.mkdirSync(path.join(proj, 'dist'));
      fs.writeFileSync(path.join(proj, 'dist/out.js'), 'ignored\n');
    });

    expect(base(path.join(proj, 'tracked.txt'))).toBe('dirty before command\n');
    expect(base(path.join(proj, 'old-untracked.txt'))).toBe('u\n');
    expect(base(path.join(proj, 'gone.txt'))).toBe('bye\n');
    expect(meta(path.join(proj, 'created.txt'))).toMatchObject({ existed: false });
    expect(hasBaseline(path.join(proj, 'dist/out.js'))).toBe(false);
    expect(events().map((e) => e.tool)).toEqual(['Bash', 'Bash', 'Bash', 'Bash']);
    // The turn's round has the file's content from before the command
    expect(fs.readFileSync(path.join(L().rounds, 'p1', `${pathKey(path.join(proj, 'tracked.txt'))}.before`), 'utf8')).toBe('dirty before command\n');
  });

  it('captures changes in a folder outside git, skipping generated folders', () => {
    fs.writeFileSync(path.join(proj, 'notes.md'), 'one\n');
    fs.mkdirSync(path.join(proj, 'node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'node_modules/x/index.js'), 'a\n');
    bash('python3 tidy.py', proj, () => {
      fs.writeFileSync(path.join(proj, 'notes.md'), 'two\n');
      fs.writeFileSync(path.join(proj, 'fresh.txt'), 'new\n');
      fs.writeFileSync(path.join(proj, 'node_modules/x/index.js'), 'b\n');
    });
    expect(base(path.join(proj, 'notes.md'))).toBe('one\n');
    expect(meta(path.join(proj, 'fresh.txt'))).toMatchObject({ existed: false });
    expect(hasBaseline(path.join(proj, 'node_modules/x/index.js'))).toBe(false);
  });

  it('keeps snapshot contents compressed and restores them exactly', () => {
    const source = 'export const value = "the same line again";\n'.repeat(300);
    fs.writeFileSync(path.join(proj, 'big.ts'), source);
    bash('./generate.sh', proj, () => fs.writeFileSync(path.join(proj, 'big.ts'), 'replaced\n'));
    expect(base(path.join(proj, 'big.ts'))).toBe(source);
    const stored = fs.readdirSync(path.join(L().snapshots, 'objects'), { recursive: true }) as string[];
    expect(stored.some((n) => n.endsWith('.br'))).toBe(true);
  });

  it('trims the snapshot cache right after a command stores a lot', () => {
    fs.mkdirSync(L().snapshots, { recursive: true });
    const stale = path.join(L().snapshots, `${'0'.repeat(40)}.json`);
    fs.writeFileSync(stale, JSON.stringify({ root: '/gone', ts: 0, files: {} }));
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
    // 3 MB of incompressible content is more than a twentieth of a 50 MB budget
    fs.writeFileSync(L().config, JSON.stringify({ snapshotCacheMB: 50 }));
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(proj, `blob${i}.bin`), crypto.randomBytes(1_000_000));
    bash('./process.sh', proj, () => fs.writeFileSync(path.join(proj, 'out.txt'), 'x\n'));
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('follows `cd` into a repository from a folder outside it', () => {
    const repo = path.join(proj, 'app');
    fs.mkdirSync(repo);
    const git = gitInit(repo);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'old\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    // The command names no file, and the starting folder skips the nested repository: only the cd target finds it
    bash('cd app && ./fix.sh', proj, () => fs.writeFileSync(path.join(repo, 'a.ts'), 'new\n'));
    expect(base(path.join(repo, 'a.ts'))).toBe('old\n');
  });

  it('tracks the project directory even when the command runs elsewhere', () => {
    fs.writeFileSync(path.join(proj, 'p.txt'), '1\n');
    const elsewhere = canonical(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-cwd-')));
    try {
      bash('make', elsewhere, () => fs.writeFileSync(path.join(proj, 'p.txt'), '2\n'), { env: { CLAUDE_PROJECT_DIR: proj } });
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
    expect(base(path.join(proj, 'p.txt'))).toBe('1\n');
  });

  it('skips read-only commands entirely', () => {
    fs.writeFileSync(path.join(proj, 'a.txt'), 'x\n');
    bash('ls -la && grep -rn x . | head', proj, () => fs.writeFileSync(path.join(proj, 'a.txt'), 'changed elsewhere\n'));
    expect(fs.readdirSync(L().staging)).toEqual([]);
    expect(hasBaseline(path.join(proj, 'a.txt'))).toBe(false);
  });

  it('does not blame Claude for a file you saved in VS Code while the command ran', () => {
    fs.writeFileSync(path.join(proj, 'mine.txt'), 'before\n');
    fs.writeFileSync(path.join(proj, 'theirs.txt'), 'before\n');
    bash('npm run build', proj, () => {
      fs.writeFileSync(path.join(proj, 'mine.txt'), 'saved by me\n');
      const hash = crypto.createHash('sha1').update('saved by me\n').digest('hex');
      fs.appendFileSync(L().userSaves, JSON.stringify({ path: path.join(proj, 'mine.txt'), ts: Date.now(), hash }) + '\n');
      fs.writeFileSync(path.join(proj, 'theirs.txt'), 'by the command\n');
    });
    expect(hasBaseline(path.join(proj, 'mine.txt'))).toBe(false);
    expect(base(path.join(proj, 'theirs.txt'))).toBe('before\n');
  });

  it('in a folder too large to snapshot, tracks only the files the command names', () => {
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(proj, `f${i}.txt`), `${i}\n`);
    const env = { CC_REVIEW_MAX_FOLDER_FILES: '3' };
    bash('echo more >> f1.txt && ./other.sh', proj, () => {
      fs.appendFileSync(path.join(proj, 'f1.txt'), 'more\n');
      fs.writeFileSync(path.join(proj, 'f2.txt'), 'changed silently\n');
      fs.writeFileSync(path.join(proj, 'made.txt'), 'x\n');
    }, { env });
    expect(base(path.join(proj, 'f1.txt'))).toBe('1\n');
    expect(hasBaseline(path.join(proj, 'f2.txt'))).toBe(false);
    expect(hasBaseline(path.join(proj, 'made.txt'))).toBe(false);
    expect(fs.readFileSync(L().hookLog, 'utf8')).toMatch(/more than 3 files/);
  });
});

describe('hook round snapshots', () => {
  const roundFile = (id: string, f: string, ext: string) => path.join(L().rounds, id, `${pathKey(f)}.${ext}`);

  function editInRound(file: string, content: string, toolUseId: string, promptId: string) {
    const input = { session_id: 's1', cwd: proj, tool_name: 'Edit', tool_use_id: toolUseId, prompt_id: promptId, tool_input: { file_path: file } };
    expect(run('pre', input).status).toBe(0);
    fs.writeFileSync(file, content);
    expect(run('post', input).status).toBe(0);
  }

  it("records each round's message; before is the content before its first write, after is after its last write", () => {
    const f = path.join(proj, 'a.ts');
    fs.writeFileSync(f, 'v0\n');
    expect(run('prompt', { session_id: 's1', cwd: proj, prompt_id: 'p1', prompt: 'change a.ts to v2' }).stdout).toBe('');
    editInRound(f, 'v1\n', 't1', 'p1');
    editInRound(f, 'v2\n', 't2', 'p1');
    run('prompt', { session_id: 's1', cwd: proj, prompt_id: 'p2', prompt: 'now change it to v3' });
    editInRound(f, 'v3\n', 't3', 'p2');

    expect(JSON.parse(fs.readFileSync(path.join(L().rounds, 'p1', 'round.json'), 'utf8'))).toMatchObject({ promptId: 'p1', session: 's1', prompt: 'change a.ts to v2' });
    expect(fs.readFileSync(roundFile('p1', f, 'before'), 'utf8')).toBe('v0\n');
    expect(fs.readFileSync(roundFile('p1', f, 'after'), 'utf8')).toBe('v2\n');
    expect(fs.readFileSync(roundFile('p2', f, 'before'), 'utf8')).toBe('v2\n');
    expect(fs.readFileSync(roundFile('p2', f, 'after'), 'utf8')).toBe('v3\n');
    expect(JSON.parse(fs.readFileSync(roundFile('p1', f, 'json'), 'utf8'))).toMatchObject({ path: f, existedBefore: true, existsAfter: true });
    // The baseline is still the content before the first edit
    expect(base(f)).toBe('v0\n');
  });

  it('has no .before for a file created in the round', () => {
    const f = path.join(proj, 'n.ts');
    editInRound(f, 'x\n', 't1', 'p1');
    expect(fs.existsSync(roundFile('p1', f, 'before'))).toBe(false);
    expect(fs.readFileSync(roundFile('p1', f, 'after'), 'utf8')).toBe('x\n');
    expect(JSON.parse(fs.readFileSync(roundFile('p1', f, 'json'), 'utf8'))).toMatchObject({ existedBefore: false });
  });

  it('records no round without prompt_id (older Claude Code)', () => {
    const f = path.join(proj, 'a.ts');
    fs.writeFileSync(f, 'v0');
    edit(f, 'v1', 't1', 's1', { prompt_id: undefined });
    expect(fs.readdirSync(L().rounds)).toEqual([]);
  });
});
