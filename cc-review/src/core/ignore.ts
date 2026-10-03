// .ccreviewignore: the hook never reads ignored files, so they are never copied to ~/.cc-review/.
// Syntax follows .gitignore: # comments, ! negation, patterns without / match a name at any depth,
// a trailing / means a directory. In the global ~/.cc-review/.ccreviewignore, patterns starting with
// / or ~/ are absolute paths; a project .ccreviewignore is rooted at its own directory, as in git.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const DEFAULT_IGNORE = `# Claude Review: matching files are never copied to ~/.cc-review/ and are not reviewed
# Same syntax as .gitignore; patterns starting with / or ~/ are absolute paths

# Secrets and credentials
.env
.env.*
!.env.example
!.env.sample
*.pem
*.key
*.p12
id_rsa*
id_ed25519*
.npmrc
.netrc
.pypirc

# Claude Code's own plan files and scratch directories
~/.claude/plans/
/private/tmp/claude-*/
/tmp/claude-*/
`;

export interface IgnoreRule {
  re: RegExp;
  negate: boolean;
}

function escapeRe(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function globToRegExpSource(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const j = glob.indexOf(']', i + 2);
      if (j === -1) {
        re += '\\[';
      } else {
        let cls = glob.slice(i + 1, j);
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        re += '[' + cls.replace(/\\/g, '\\\\') + ']';
        i = j;
      }
    } else if (c === '\\' && i + 1 < glob.length) {
      i++;
      re += escapeRe(glob[i]);
    } else {
      re += escapeRe(c);
    }
  }
  return re;
}

/** baseDir is undefined for the global file. */
export function parseIgnore(content: string, baseDir: string | undefined, home = os.homedir()): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let raw of content.split(/\r?\n/)) {
    raw = raw.trim();
    if (!raw || raw.startsWith('#')) continue;
    let negate = false;
    if (raw.startsWith('!')) {
      negate = true;
      raw = raw.slice(1);
    }
    if (raw.endsWith('/')) raw = raw.slice(0, -1);
    if (!raw) continue;

    let prefix: string;
    let pattern = raw;
    if (pattern.startsWith('~/')) {
      prefix = '^' + escapeRe(home.replace(/\/$/, '')) + '/';
      pattern = pattern.slice(2);
    } else if (pattern.startsWith('/')) {
      prefix = baseDir === undefined ? '^/' : '^' + escapeRe(baseDir.replace(/\/$/, '')) + '/';
      pattern = pattern.slice(1);
    } else if (pattern.includes('/') && baseDir !== undefined) {
      prefix = '^' + escapeRe(baseDir.replace(/\/$/, '')) + '/';
    } else {
      // Any depth
      prefix = baseDir === undefined ? '(?:^|/)' : '^' + escapeRe(baseDir.replace(/\/$/, '')) + '/(?:.*/)?';
    }
    // A matching directory matches everything below it
    rules.push({ re: new RegExp(prefix + globToRegExpSource(pattern) + '(?:/.*)?$'), negate });
  }
  return rules;
}

/** Later rules win, as in .gitignore. */
export function matchRules(rules: IgnoreRule[], absPath: string): boolean | undefined {
  let result: boolean | undefined;
  for (const r of rules) if (r.re.test(absPath)) result = !r.negate;
  return result;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Find the nearest .ccreviewignore walking up from the file's directory. */
function nearestProjectIgnore(absPath: string): { dir: string; content: string } | undefined {
  let dir = path.dirname(absPath);
  for (let i = 0; i < 64; i++) {
    const content = readText(path.join(dir, '.ccreviewignore'));
    if (content !== undefined) return { dir, content };
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export function isIgnored(absPath: string, globalIgnoreFile: string, reviewRootDir: string): boolean {
  // Always ignore our own data directory
  const rel = path.relative(reviewRootDir, absPath);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;

  const globalContent = readText(globalIgnoreFile) ?? DEFAULT_IGNORE;
  let result = matchRules(parseIgnore(globalContent, undefined), absPath);
  const project = nearestProjectIgnore(absPath);
  if (project) {
    const r = matchRules(parseIgnore(project.content, project.dir), absPath);
    if (r !== undefined) result = r;
  }
  return result === true;
}
