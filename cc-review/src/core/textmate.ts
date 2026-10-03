// Syntax highlighting for phantom lines, using the same vscode-textmate + Oniguruma stack as VS Code, so colors match the editor.
import * as fs from 'node:fs';
import * as oniguruma from 'vscode-oniguruma';
import { INITIAL, parseRawGrammar, Registry, type IGrammar, type IRawTheme, type StateStack } from 'vscode-textmate';

/** [text, color (null = default foreground), font style bits: 1 italic, 2 bold, 4 underline, 8 strikethrough] */
export type StyledSpan = [text: string, color: string | null, fontStyle: number];

export interface GrammarSource {
  /** scopeName -> grammar file (.json, or a plist .tmLanguage) */
  grammarPath(scopeName: string): string | undefined;
  /** Grammars injected into this scope, e.g. JSDoc into TypeScript */
  injections(scopeName: string): string[];
}

// Token metadata layout used by vscode-textmate (EncodedTokenAttributes, not exported)
const FONT_STYLE_MASK = 0b00000000000000000111100000000000;
const FONT_STYLE_OFFSET = 11;
const FOREGROUND_MASK = 0b00000000111111111000000000000000;
const FOREGROUND_OFFSET = 15;

/** Same as the default editor.maxTokenizationLineLength: longer lines are not colored */
const MAX_LINE_LENGTH = 20_000;
/** Start tokenizing at most this many lines before the removed lines; further back, start there from the initial state (approximate) */
const MAX_PREFIX_LINES = 5_000;
const LINE_TIME_LIMIT_MS = 200;

let onigLoaded: Promise<void> | undefined;

function loadOniguruma(wasmPath: string): Promise<void> {
  onigLoaded ??= (async () => {
    const b = await fs.promises.readFile(wasmPath);
    await oniguruma.loadWASM(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  })();
  return onigLoaded;
}

interface DocStates {
  hash: string;
  scope: string;
  /** states[k] is the tokenizer state at the start of line start + k */
  start: number;
  states: StateStack[];
}

export class TextMateHighlighter {
  private readonly registry: Registry;
  private readonly grammars = new Map<string, Promise<IGrammar | null>>();
  private readonly loaded = new Map<string, IGrammar>();
  private readonly docs = new Map<string, DocStates>();
  private defaultForeground = '';

  constructor(
    wasmPath: string,
    private readonly source: GrammarSource,
    theme: IRawTheme,
  ) {
    this.registry = new Registry({
      onigLib: loadOniguruma(wasmPath).then(() => ({
        createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
        createOnigString: (s: string) => new oniguruma.OnigString(s),
      })),
      loadGrammar: async (scopeName) => {
        const file = this.source.grammarPath(scopeName);
        if (!file) return null;
        try {
          return parseRawGrammar(await fs.promises.readFile(file, 'utf8'), file);
        } catch {
          return null;
        }
      },
      getInjections: (scopeName) => this.source.injections(scopeName),
    });
    this.setTheme(theme);
  }

  setTheme(theme: IRawTheme): void {
    this.registry.setTheme(theme);
    // Rules without a scope are global defaults; later ones override earlier ones
    let fg = '';
    for (const s of theme.settings) if (!s.scope && s.settings.foreground) fg = s.settings.foreground;
    this.defaultForeground = fg.toUpperCase();
    // Tokenizer states carry styles resolved against the old theme, so re-tokenize after a theme change
    this.docs.clear();
  }

  private grammar(scopeName: string): Promise<IGrammar | null> {
    let g = this.grammars.get(scopeName);
    if (!g) {
      // vscode-textmate throws when a grammar is missing; treat that as "no grammar"
      g = this.registry.loadGrammar(scopeName).then(
        (x) => {
          if (x) this.loaded.set(scopeName, x);
          return x;
        },
        () => null,
      );
      this.grammars.set(scopeName, g);
    }
    return g;
  }

  private docStates(docKey: string, hash: string, scope: string, from: number): DocStates {
    const start = Math.max(0, from - MAX_PREFIX_LINES);
    let d = this.docs.get(docKey);
    if (!d || d.hash !== hash || d.scope !== scope || start < d.start) {
      d = { hash, scope, start, states: [INITIAL] };
      this.docs.set(docKey, d);
      if (this.docs.size > 100) this.docs.delete(this.docs.keys().next().value!);
    }
    return d;
  }

  private advance(g: IGrammar, d: DocStates, lines: readonly string[], until: number): void {
    for (let line = d.start + d.states.length - 1; line < until && line < lines.length; line++) {
      const text = lines[line];
      const state = d.states[d.states.length - 1];
      d.states.push(text.length > MAX_LINE_LENGTH ? state : g.tokenizeLine2(text, state, LINE_TIME_LIMIT_MS).ruleStack);
    }
  }

  private spans(g: IGrammar, d: DocStates, lines: readonly string[], from: number, count: number): StyledSpan[][] {
    const colors = this.registry.getColorMap();
    const out: StyledSpan[][] = [];
    for (let line = from; line < Math.min(lines.length, from + count); line++) {
      const text = lines[line];
      const state = d.states[line - d.start];
      if (!state || text.length > MAX_LINE_LENGTH) {
        out.push([[text, null, 0]]);
        continue;
      }
      const tokens = g.tokenizeLine2(text, state, LINE_TIME_LIMIT_MS).tokens;
      const row: StyledSpan[] = [];
      const n = tokens.length / 2;
      for (let i = 0; i < n; i++) {
        const s = tokens[2 * i];
        const e = i + 1 < n ? tokens[2 * i + 2] : text.length;
        if (e <= s) continue;
        const meta = tokens[2 * i + 1];
        const fg = colors[(meta & FOREGROUND_MASK) >>> FOREGROUND_OFFSET];
        const color = fg && fg.toUpperCase() !== this.defaultForeground ? fg : null;
        const style = (meta & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET;
        const last = row[row.length - 1];
        if (last && last[1] === color && last[2] === style) last[0] += text.slice(s, e);
        else row.push([text.slice(s, e), color, style]);
      }
      out.push(row.length ? row : [[text, null, 0]]);
    }
    return out;
  }

  /**
   * Color lines [from, from + count) of the whole file `lines`. Tokenization starts at the top of the
   * file (or nearby when that is too far), so removed lines inside multi-line comments or template
   * strings are colored correctly. Tokenizer state is reused for the same docKey + hash.
   */
  async highlight(docKey: string, hash: string, scopeName: string, lines: readonly string[], from: number, count: number): Promise<StyledSpan[][] | undefined> {
    const g = await this.grammar(scopeName);
    if (!g) return undefined;
    const d = this.docStates(docKey, hash, scopeName, from);
    // Advance in batches so long files do not hog the extension host
    while (d.start + d.states.length - 1 < from) {
      this.advance(g, d, lines, Math.min(from, d.start + d.states.length - 1 + 500));
      if (d.start + d.states.length - 1 < from) await new Promise((r) => setImmediate(r));
      if (this.docs.get(docKey) !== d) return this.highlight(docKey, hash, scopeName, lines, from, count);
    }
    this.advance(g, d, lines, from + count);
    return this.spans(g, d, lines, from, count);
  }

  /** Returns synchronously when the preceding lines are already tokenized (phantom lines get colors on creation, no flash); otherwise undefined */
  peek(docKey: string, hash: string, scopeName: string, lines: readonly string[], from: number, count: number): StyledSpan[][] | undefined {
    const g = this.loaded.get(scopeName);
    const d = this.docs.get(docKey);
    if (!g || !d || d.hash !== hash || d.scope !== scopeName || d.start > Math.max(0, from - MAX_PREFIX_LINES) || d.start + d.states.length - 1 < from) {
      return undefined;
    }
    this.advance(g, d, lines, from + count);
    return this.spans(g, d, lines, from, count);
  }

  dispose(): void {
    this.registry.dispose();
  }
}
