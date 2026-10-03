import { describe, expect, it } from 'vitest';
import { DEFAULT_IGNORE, matchRules, parseIgnore } from '../../src/core/ignore';

const HOME = '/Users/me';

describe('.ccreviewignore', () => {
  const global = parseIgnore(DEFAULT_IGNORE, undefined, HOME);

  it('default rules ignore .env and other secrets but not .env.example', () => {
    expect(matchRules(global, '/Users/me/proj/.env')).toBe(true);
    expect(matchRules(global, '/Users/me/proj/sub/.env.local')).toBe(true);
    expect(matchRules(global, '/Users/me/proj/.env.example')).toBe(false);
    expect(matchRules(global, '/Users/me/proj/certs/server.pem')).toBe(true);
    expect(matchRules(global, '/Users/me/proj/src/env.ts')).toBeUndefined();
  });

  it('global patterns starting with ~/ or / are absolute paths', () => {
    expect(matchRules(global, '/Users/me/.claude/plans/x.md')).toBe(true);
    expect(matchRules(global, '/private/tmp/claude-501/abc/scratch.txt')).toBe(true);
    expect(matchRules(global, '/Users/me/proj/.claude/plans/x.md')).toBeUndefined();
  });

  it('a project file is rooted at its directory', () => {
    const rules = parseIgnore('/build\nsecret/*.json\n*.log\n!keep.log\n', '/repo', HOME);
    expect(matchRules(rules, '/repo/build/out.js')).toBe(true);
    expect(matchRules(rules, '/repo/src/build/out.js')).toBeUndefined();
    expect(matchRules(rules, '/repo/secret/a.json')).toBe(true);
    expect(matchRules(rules, '/repo/secret/deep/a.json')).toBeUndefined();
    expect(matchRules(rules, '/repo/x/y/z.log')).toBe(true);
    expect(matchRules(rules, '/repo/x/keep.log')).toBe(false);
    expect(matchRules(rules, '/other/z.log')).toBeUndefined();
  });

  it('** matches any depth', () => {
    const rules = parseIgnore('src/**/gen/*.ts\n', '/repo', HOME);
    expect(matchRules(rules, '/repo/src/gen/a.ts')).toBe(true);
    expect(matchRules(rules, '/repo/src/a/b/gen/a.ts')).toBe(true);
    expect(matchRules(rules, '/repo/lib/gen/a.ts')).toBeUndefined();
  });
});
