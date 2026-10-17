import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { analyzeCommand } from '../../src/core/command';

const at = (cmd: string) => analyzeCommand(cmd, '/p');

describe('analyzeCommand', () => {
  it('recognizes read-only commands', () => {
    for (const cmd of [
      'ls -la',
      'grep -rn "foo > bar" src | head -20',
      'git status && git diff HEAD~1 -- src',
      'git -C /repo log --oneline',
      'cat a.txt 2>/dev/null',
      "sed -n '1,5p' a.ts",
      "find . -name '*.ts' -type f",
      'cd /x && ls',
      'wc -l src/*.ts 2>&1',
    ]) {
      expect(at(cmd).readOnly, cmd).toBe(true);
    }
  });

  it('treats anything that may write as writing', () => {
    for (const cmd of [
      "sed -i '' 's/a/b/' a.ts",
      'echo hi > a.txt',
      'echo hi>>a.txt',
      'npm test',
      'python3 script.py',
      'find . -name "*.tmp" -delete',
      'git checkout -- a.ts',
      'git stash',
      'cat a | tee b',
      'ls $(rm -rf x)',
      'sort -o out.txt in.txt',
      'ls >&out.txt',
      "python3 - <<'EOF'\nprint(1)\nEOF",
    ]) {
      expect(at(cmd).readOnly, cmd).toBe(false);
    }
  });

  it('follows cd, subshells and git -C', () => {
    expect(at('cd sub && echo hi > a.txt').dirs).toEqual(['/p', '/p/sub']);
    expect(at('(cd a && make) && cd b && make').dirs).toEqual(['/p', '/p/a', '/p/b']);
    expect(at('git -C /repo checkout .').dirs).toEqual(['/p', '/repo']);
    expect(at('cd ~/x && rm y.txt').dirs).toEqual(['/p', `${os.homedir()}/x`]);
  });

  it('collects mentioned paths, resolved where the command runs', () => {
    expect(at('cd sub && echo hi > a.txt').paths).toContain('/p/sub/a.txt');
    expect(at("sed -i '' s/a/b/ src/*.ts").paths).toContain('/p/src');
    expect(at('cmd > /tmp/out 2>&1').paths).toEqual(['/tmp/out']);
    expect(at('echo x >&2').paths).toEqual([]);
    const py = at("cd /w/cc && python3 - <<'EOF'\nimport pathlib\npathlib.Path('src/a.ts').write_text('x')\nEOF");
    expect(py.paths).toContain('/w/cc/src/a.ts');
    expect(py.dirs).toEqual(['/p', '/w/cc']);
  });
});
