// Checks coloring with a minimal TextMate grammar and theme: cross-line state, injections, caching, theme changes.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TextMateHighlighter, type StyledSpan } from '../../src/core/textmate';

const WASM = path.resolve(__dirname, '../../node_modules/vscode-oniguruma/release/onig.wasm');

let dir: string;
let tm: TextMateHighlighter;

const grammar = {
  scopeName: 'source.demo',
  patterns: [
    // begin/end as in real grammars, so the injection can match inside the comment
    { name: 'comment.line.demo', begin: '//', end: '$' },
    { name: 'comment.block.demo', begin: '/\\*', end: '\\*/' },
    { name: 'keyword.control.demo', match: '\\b(let|const)\\b' },
    { name: 'string.quoted.demo', begin: '"', end: '"' },
  ],
};

const injection = {
  scopeName: 'todo.injection',
  injectionSelector: 'L:comment',
  patterns: [{ name: 'keyword.todo', match: 'TODO' }],
};

const darkTheme = {
  name: 'demo-dark',
  settings: [
    { settings: { foreground: '#D4D4D4', background: '#1E1E1E' } },
    { scope: 'comment', settings: { foreground: '#6A9955', fontStyle: 'italic' } },
    { scope: 'keyword', settings: { foreground: '#C586C0' } },
    { scope: 'keyword.todo', settings: { foreground: '#FF0000', fontStyle: 'bold' } },
    { scope: 'string', settings: { foreground: '#CE9178' } },
  ],
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-tm-'));
  fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify(grammar));
  fs.writeFileSync(path.join(dir, 'todo.json'), JSON.stringify(injection));
  tm = new TextMateHighlighter(
    WASM,
    {
      grammarPath: (s) => (s === 'source.demo' ? path.join(dir, 'demo.json') : s === 'todo.injection' ? path.join(dir, 'todo.json') : undefined),
      injections: (s) => (s === 'source.demo' ? ['todo.injection'] : []),
    },
    darkTheme,
  );
});

afterAll(() => {
  tm.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

const colorOf = (row: StyledSpan[], text: string) => row.find(([t]) => t.includes(text))?.[1];
const styleOf = (row: StyledSpan[], text: string) => row.find(([t]) => t.includes(text))?.[2];

const lines = ['let a = "x"; // TODO hi', '/* start', 'inside comment', 'end */ const b'];

describe('TextMateHighlighter', () => {
  it('colors keywords, strings and comments by theme; default-foreground text has no color', async () => {
    const [row] = (await tm.highlight('doc', 'h1', 'source.demo', lines, 0, 1))!;
    expect(row.map(([t]) => t).join('')).toBe(lines[0]);
    expect(colorOf(row, 'let')).toBe('#C586C0');
    expect(colorOf(row, '"x"')).toBe('#CE9178');
    expect(colorOf(row, ' a = ')).toBeNull();
    expect(colorOf(row, '//')).toBe('#6A9955');
    expect(styleOf(row, '//')).toBe(1); // italic
  });

  it('applies injection grammars (TODO inside a comment)', async () => {
    const [row] = (await tm.highlight('doc', 'h1', 'source.demo', lines, 0, 1))!;
    expect(colorOf(row, 'TODO')).toBe('#FF0000');
    expect(styleOf(row, 'TODO')).toBe(2); // bold
  });

  it('tokenizes from the top: a line inside a block comment gets the comment color', async () => {
    const [inside, end] = (await tm.highlight('doc', 'h1', 'source.demo', lines, 2, 2))!;
    expect(inside).toEqual([['inside comment', '#6A9955', 1]]);
    expect(colorOf(end, 'end */')).toBe('#6A9955');
    expect(colorOf(end, 'const')).toBe('#C586C0');
  });

  it('peek returns synchronously once tokenized, but not after the content (hash) changed', async () => {
    await tm.highlight('doc2', 'v1', 'source.demo', lines, 3, 1);
    expect(tm.peek('doc2', 'v1', 'source.demo', lines, 2, 1)).toEqual([[['inside comment', '#6A9955', 1]]]);
    expect(tm.peek('doc2', 'v2', 'source.demo', lines, 2, 1)).toBeUndefined();
    expect(tm.peek('other', 'v1', 'source.demo', lines, 2, 1)).toBeUndefined();
  });

  it('returns undefined for a language without a grammar', async () => {
    expect(await tm.highlight('doc', 'h1', 'source.unknown', lines, 0, 1)).toBeUndefined();
  });

  it('changes colors with the theme and invalidates cached tokenizer state', async () => {
    tm.setTheme({ name: 'light', settings: [{ settings: { foreground: '#000000' } }, { scope: 'keyword', settings: { foreground: '#0000FF' } }] });
    expect(tm.peek('doc', 'h1', 'source.demo', lines, 0, 1)).toBeUndefined();
    const [row] = (await tm.highlight('doc', 'h1', 'source.demo', lines, 0, 1))!;
    expect(colorOf(row, 'let')).toBe('#0000FF');
    expect(colorOf(row, '//')).toBeNull();
    tm.setTheme(darkTheme);
  });

  it('advances long files in batches with the same result', async () => {
    const big = Array.from({ length: 3000 }, (_, i) => (i === 10 ? '/* open' : i === 2990 ? 'close */ let z' : `line ${i}`));
    const rows = (await tm.highlight('big', 'b1', 'source.demo', big, 2990, 1))!;
    expect(colorOf(rows[0], 'close */')).toBe('#6A9955');
    expect(colorOf(rows[0], 'let')).toBe('#C586C0');
  });
});
