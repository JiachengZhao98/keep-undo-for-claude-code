// Shell command analysis for tracking Bash edits: the directories a command runs in (its starting
// directory and every `cd` target), the paths it mentions, and whether it is clearly read-only so the
// before/after snapshots can be skipped. Heuristic: when unsure, a command counts as one that writes.
import * as os from 'node:os';
import * as path from 'node:path';

export interface CommandInfo {
  /** The starting directory, then every directory the command changes into */
  dirs: string[];
  /** Absolute paths the command mentions (they may not exist); a glob is cut before its first wildcard segment */
  paths: string[];
  readOnly: boolean;
}

const MAX_PATHS = 200;

/** Commands that never change files (as long as they have no output redirection) */
const READ_ONLY = new Set([
  'cd', 'pushd', 'popd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'echo', 'printf',
  'pwd', 'which', 'whereis', 'type', 'file', 'stat', 'du', 'df', 'tree', 'cut', 'tr', 'nl', 'diff', 'cmp', 'comm', 'basename',
  'dirname', 'realpath', 'readlink', 'date', 'printenv', 'id', 'whoami', 'uname', 'hostname', 'true', 'false', 'test', '[',
  'sleep', 'jq', 'column', 'less', 'more', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'xxd', 'hexdump', 'od',
  'strings', 'ps', 'lsof', 'man', 'sort', 'uniq', 'sed', 'awk', 'find', 'git',
]);

/** git subcommands that leave the working tree alone */
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'grep', 'describe', 'shortlog', 'cat-file',
  'rev-list', 'branch', 'tag', 'remote', 'config', 'fetch', 'push', 'add', 'reflog', 'show-ref', 'for-each-ref',
  'check-ignore', 'var', 'help', 'version', '--version',
]);

const FIND_WRITES = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);

type Tok = { kind: 'word'; v: string } | { kind: 'op'; v: string };

/** Cut heredoc bodies out of the command; they are data, not shell words */
function stripHeredocs(src: string): { rest: string; bodies: string[] } {
  const lines = src.split('\n');
  const rest: string[] = [];
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    rest.push(lines[i]);
    const delims = [...lines[i].matchAll(/(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g)].map((m) => ({ tabs: m[1] === '-', word: m[3] }));
    for (const d of delims) {
      const body: string[] = [];
      while (++i < lines.length && (d.tabs ? lines[i].replace(/^\t+/, '') : lines[i]) !== d.word) body.push(lines[i]);
      bodies.push(body.join('\n'));
    }
  }
  return { rest: rest.join('\n'), bodies };
}

function tokenize(src: string): { toks: Tok[]; substitution: boolean } {
  const toks: Tok[] = [];
  let substitution = false;
  let w: string | undefined;
  const flush = () => {
    if (w !== undefined) toks.push({ kind: 'word', v: w });
    w = undefined;
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] !== '\n') w = (w ?? '') + (src[i + 1] ?? '');
      i += 2;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      w = (w ?? '') + src.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else {
          if (src[j] === '`' || (src[j] === '$' && src[j + 1] === '(')) substitution = true;
          s += src[j++];
        }
      }
      w = (w ?? '') + s;
      i = j + 1;
    } else if (c === '#' && w === undefined) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
    } else if (c === '\n') {
      flush();
      toks.push({ kind: 'op', v: ';' });
      i++;
    } else {
      if (c === '`' || (c === '$' && src[i + 1] === '(')) substitution = true;
      const re = w === undefined ? /^(?:\d*>>|\d*>[&|]?|&>>|&>|<<<|<<-?|<&|<|&&|\|\||;;|[;&|()])/ : /^(?:>>|>[&|]?|<<<|<<-?|<&|<|&&|\|\||;;|[;&|()])/;
      const m = re.exec(src.slice(i));
      if (m) {
        flush();
        toks.push({ kind: 'op', v: m[0] });
        i += m[0].length;
      } else {
        w = (w ?? '') + c;
        i++;
      }
    }
  }
  flush();
  return { toks, substitution };
}

function expandHome(p: string): string {
  const home = os.homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}

/** A word that names a file or directory, cut before any wildcard segment; undefined otherwise */
function pathOf(word: string): string | undefined {
  let s = word.includes('=') && !word.startsWith('/') ? word.slice(word.indexOf('=') + 1) : word;
  if (!s || s.length > 1024 || s.startsWith('-') || s.includes('://') || /[\s`]/.test(s)) return undefined;
  s = expandHome(s);
  if (s.includes('$')) return undefined;
  const wild = s.search(/[*?[]/);
  if (wild >= 0) {
    const cut = s.lastIndexOf('/', wild);
    return cut > 0 ? s.slice(0, cut) : undefined;
  }
  return s.includes('/') || /^[\w.@+-]+\.[A-Za-z0-9]{1,10}$/.test(s) ? s : undefined;
}

function gitReadOnly(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i].startsWith('-') && args[i] !== '--version') i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
  const sub = args[i];
  if (sub === undefined) return true;
  if (sub === 'stash') return args[i + 1] === 'list' || args[i + 1] === 'show';
  return READ_ONLY_GIT.has(sub);
}

function simpleReadOnly(words: string[]): boolean {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  if (i >= words.length) return true;
  const name = path.basename(words[i]);
  const args = words.slice(i + 1);
  if (!READ_ONLY.has(name)) return false;
  switch (name) {
    case 'git':
      return gitReadOnly(args);
    case 'find':
      return !args.some((a) => FIND_WRITES.has(a));
    case 'sed':
      return !args.some((a) => a === '--in-place' || a.startsWith('--in-place=') || /^-[A-Za-z]*i/.test(a));
    case 'sort':
      return !args.some((a) => a.startsWith('--output') || /^-[A-Za-z]*o/.test(a));
    case 'awk':
      return !args.some((a) => a.includes('>') || a.includes('system('));
    case 'uniq':
      return args.filter((a) => !a.startsWith('-')).length < 2;
    default:
      return true;
  }
}

export function analyzeCommand(command: string, cwd: string): CommandInfo {
  const { rest, bodies } = stripHeredocs(command);
  const { toks, substitution } = tokenize(rest);
  const dirs = [cwd];
  const paths = new Set<string>();
  let readOnly = !substitution;
  const dirStack: string[] = [];
  let cur = cwd;
  let words: string[] = [];

  const addPath = (p: string | undefined, base = cur) => {
    if (p !== undefined && paths.size < MAX_PATHS) paths.add(path.resolve(base, p));
  };
  const addDir = (d: string) => {
    if (!dirs.includes(d)) dirs.push(d);
  };
  const endCommand = () => {
    if (words.length === 0) return;
    if (!simpleReadOnly(words)) readOnly = false;
    const name = path.basename(words[0]);
    if ((name === 'cd' || name === 'pushd') && words.length > 1) {
      const target = words.slice(1).find((a) => a !== '-P' && a !== '-L');
      if (target !== undefined && target !== '-') {
        cur = path.resolve(cur, expandHome(target));
        addDir(cur);
      }
    } else {
      for (let k = 1; k < words.length; k++) {
        // `git -C dir` and `make -C dir` run in another directory
        if (words[k] === '-C' && (name === 'git' || name === 'make') && words[k + 1] !== undefined) addDir(path.resolve(cur, expandHome(words[k + 1])));
        addPath(pathOf(words[k]));
      }
      addPath(pathOf(words[0]));
    }
    words = [];
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'word') {
      words.push(t.v);
      continue;
    }
    const op = t.v;
    if (/^(?:\d*>>|\d*>[|]?|&>>|&>)$/.test(op) || (op.endsWith('>&') && toks[i + 1]?.kind === 'word' && !/^\d+$|^-$/.test(toks[i + 1].v))) {
      // Output redirection to a file
      const target = toks[i + 1]?.kind === 'word' ? toks[++i].v : undefined;
      if (target !== '/dev/null') {
        readOnly = false;
        addPath(pathOf(target ?? '') ?? (target ? expandHome(target) : undefined));
      }
    } else if (op.endsWith('>&') || op === '<&' || op === '<' || op === '<<<' || op.startsWith('<<')) {
      if (toks[i + 1]?.kind === 'word') i++;
    } else {
      endCommand();
      if (op === '(') dirStack.push(cur);
      else if (op === ')') cur = dirStack.pop() ?? cur;
    }
  }
  endCommand();

  // Paths quoted inside heredoc bodies (scripts fed to python, node, ...) are relative to the last directory
  for (const body of bodies) {
    for (const m of body.matchAll(/(['"])((?:(?!\1)[^\\\n])+)\1/g)) addPath(pathOf(m[2]));
  }
  return { dirs, paths: [...paths], readOnly };
}
