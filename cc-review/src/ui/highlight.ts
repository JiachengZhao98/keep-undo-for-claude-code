// Locates the active theme and the language grammars and hands them to core/textmate.ts for coloring.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as jsonc from 'jsonc-parser';
import * as vscode from 'vscode';
import { parseRawGrammar, type IRawTheme } from 'vscode-textmate';
import { TextMateHighlighter, type GrammarSource, type StyledSpan } from '../core/textmate';

type RawRule = IRawTheme['settings'][number];

interface GrammarContribution {
  language?: unknown;
  scopeName?: unknown;
  path?: unknown;
  injectTo?: unknown;
}

interface ThemeContribution {
  id?: unknown;
  label?: unknown;
  uiTheme?: unknown;
  path?: unknown;
}

/** All grammars contributed by installed extensions (built-ins included) */
export class GrammarIndex implements GrammarSource {
  private scopes = new Map<string, string>();
  private languages = new Map<string, string>();
  private injectionMap = new Map<string, string[]>();

  constructor() {
    this.rebuild();
  }

  rebuild(): void {
    this.scopes.clear();
    this.languages.clear();
    this.injectionMap.clear();
    const appRoot = vscode.env.appRoot;
    // Register built-in extensions first so user-installed grammars override them
    const exts = [...vscode.extensions.all].sort(
      (a, b) => Number(!a.extensionUri.fsPath.startsWith(appRoot)) - Number(!b.extensionUri.fsPath.startsWith(appRoot)),
    );
    for (const ext of exts) {
      const grammars = (ext.packageJSON as { contributes?: { grammars?: unknown } })?.contributes?.grammars;
      if (!Array.isArray(grammars)) continue;
      for (const g of grammars as GrammarContribution[]) {
        if (typeof g?.scopeName !== 'string' || typeof g.path !== 'string') continue;
        this.scopes.set(g.scopeName, vscode.Uri.joinPath(ext.extensionUri, g.path).fsPath);
        if (typeof g.language === 'string') this.languages.set(g.language, g.scopeName);
        if (Array.isArray(g.injectTo)) {
          for (const target of g.injectTo) {
            if (typeof target !== 'string') continue;
            const list = this.injectionMap.get(target) ?? [];
            if (!list.includes(g.scopeName)) list.push(g.scopeName);
            this.injectionMap.set(target, list);
          }
        }
      }
    }
  }

  scopeForLanguage(languageId: string): string | undefined {
    return this.languages.get(languageId);
  }

  grammarPath(scopeName: string): string | undefined {
    return this.scopes.get(scopeName);
  }

  injections(scopeName: string): string[] {
    return this.injectionMap.get(scopeName) ?? [];
  }
}

const KIND_OF_UI_THEME: Record<string, vscode.ColorThemeKind> = {
  vs: vscode.ColorThemeKind.Light,
  'vs-dark': vscode.ColorThemeKind.Dark,
  'hc-black': vscode.ColorThemeKind.HighContrast,
  'hc-light': vscode.ColorThemeKind.HighContrastLight,
};

/** VS Code's default foreground when a theme does not set editor.foreground */
const DEFAULT_FOREGROUND: Record<number, string> = {
  [vscode.ColorThemeKind.Light]: '#333333',
  [vscode.ColorThemeKind.Dark]: '#BBBBBB',
  [vscode.ColorThemeKind.HighContrast]: '#FFFFFF',
  [vscode.ColorThemeKind.HighContrastLight]: '#292929',
};

/** Scopes behind the shorthand keys of editor.tokenColorCustomizations, as in VS Code */
const TOKEN_GROUPS: Record<string, string[]> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

/** Name of the active theme, honoring OS light/dark and high-contrast auto-detection */
function themeCandidates(): string[] {
  const wb = vscode.workspace.getConfiguration('workbench');
  const win = vscode.workspace.getConfiguration('window');
  const kind = vscode.window.activeColorTheme.kind;
  const names: Array<string | undefined> = [];
  if (kind === vscode.ColorThemeKind.HighContrast) names.push(wb.get('preferredHighContrastColorTheme'));
  if (kind === vscode.ColorThemeKind.HighContrastLight) names.push(wb.get('preferredHighContrastLightColorTheme'));
  if (win.get<boolean>('autoDetectColorScheme')) {
    names.push(wb.get(kind === vscode.ColorThemeKind.Light ? 'preferredLightColorTheme' : 'preferredDarkColorTheme'));
  }
  names.push(wb.get('colorTheme'));
  return names.filter((n): n is string => typeof n === 'string' && n.length > 0);
}

/** If nothing is found, fall back to VS Code's built-in default for the theme kind (the 2026 themes since 1.140) */
const KIND_DEFAULT: Record<number, string[]> = {
  [vscode.ColorThemeKind.Light]: ['Light 2026', 'Light Modern', 'Light+'],
  [vscode.ColorThemeKind.Dark]: ['Dark 2026', 'Dark Modern', 'Dark+'],
  [vscode.ColorThemeKind.HighContrast]: ['Default High Contrast'],
  [vscode.ColorThemeKind.HighContrastLight]: ['Default High Contrast Light'],
};

/** Settings may still hold an old id (e.g. "Default Light Modern" before 1.140, now "Light Modern") */
function findTheme(name: string): { file: string; uiTheme: string } | undefined {
  return findThemeExact(name) ?? (name.startsWith('Default ') ? findThemeExact(name.slice('Default '.length)) : undefined);
}

function findThemeExact(name: string): { file: string; uiTheme: string } | undefined {
  for (const ext of vscode.extensions.all) {
    const themes = (ext.packageJSON as { contributes?: { themes?: unknown } })?.contributes?.themes;
    if (!Array.isArray(themes)) continue;
    for (const t of themes as ThemeContribution[]) {
      if ((t?.id === name || t?.label === name) && typeof t.path === 'string') {
        return { file: vscode.Uri.joinPath(ext.extensionUri, t.path).fsPath, uiTheme: String(t.uiTheme ?? '') };
      }
    }
  }
  return undefined;
}

interface ThemeFile {
  colors: Record<string, string>;
  tokenColors: RawRule[];
}

async function readTokenColorFile(file: string): Promise<RawRule[]> {
  const text = await fs.promises.readFile(file, 'utf8');
  if (/\.json$/i.test(file)) {
    const json = jsonc.parse(text, [], { allowTrailingComma: true }) as { tokenColors?: unknown; settings?: unknown } | unknown[];
    if (Array.isArray(json)) return json as RawRule[];
    return ((json as { tokenColors?: unknown }).tokenColors ?? (json as { settings?: unknown }).settings ?? []) as RawRule[];
  }
  // .tmTheme is a plist; reuse vscode-textmate's parser
  const plist = parseRawGrammar(text, file) as unknown as { settings?: RawRule[] };
  return plist.settings ?? [];
}

async function readThemeFile(file: string, depth = 0): Promise<ThemeFile> {
  if (/\.tmTheme$/i.test(file)) return { colors: {}, tokenColors: await readTokenColorFile(file) };
  const json = jsonc.parse(await fs.promises.readFile(file, 'utf8'), [], { allowTrailingComma: true }) as {
    include?: unknown;
    colors?: Record<string, string>;
    tokenColors?: unknown;
  };
  // Merge the included theme first; this theme's settings override it
  const base: ThemeFile =
    typeof json.include === 'string' && depth < 10 ? await readThemeFile(path.join(path.dirname(file), json.include), depth + 1) : { colors: {}, tokenColors: [] };
  const own: RawRule[] =
    typeof json.tokenColors === 'string'
      ? await readTokenColorFile(path.join(path.dirname(file), json.tokenColors))
      : Array.isArray(json.tokenColors)
        ? (json.tokenColors as RawRule[])
        : [];
  return { colors: { ...base.colors, ...(json.colors ?? {}) }, tokenColors: [...base.tokenColors, ...own] };
}

function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(name);
}

/** Your overrides in editor.tokenColorCustomizations: global and per theme name (with * wildcards) */
function customizations(themeName: string): RawRule[] {
  const all = vscode.workspace.getConfiguration('editor').get<Record<string, unknown>>('tokenColorCustomizations') ?? {};
  const out: RawRule[] = [];
  const apply = (c: unknown) => {
    if (!c || typeof c !== 'object') return;
    const o = c as Record<string, unknown>;
    for (const [group, scope] of Object.entries(TOKEN_GROUPS)) {
      const v = o[group];
      if (typeof v === 'string') out.push({ scope, settings: { foreground: v } });
      else if (v && typeof v === 'object') out.push({ scope, settings: v as RawRule['settings'] });
    }
    if (Array.isArray(o.textMateRules)) out.push(...(o.textMateRules as RawRule[]));
  };
  apply(all);
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('[') && k.endsWith(']') && globMatch(k.slice(1, -1), themeName)) apply(v);
  }
  return out;
}

export async function loadActiveTheme(): Promise<{ name: string; theme: IRawTheme } | undefined> {
  const kind = vscode.window.activeColorTheme.kind;
  const names = [...themeCandidates(), ...(KIND_DEFAULT[kind] ?? [])];
  let found: { name: string; file: string } | undefined;
  // Prefer a theme whose kind matches the active one
  for (const strict of [true, false]) {
    for (const name of names) {
      const t = findTheme(name);
      if (t && (!strict || KIND_OF_UI_THEME[t.uiTheme] === kind)) {
        found = { name, file: t.file };
        break;
      }
    }
    if (found) break;
  }
  if (!found) return undefined;
  const data = await readThemeFile(found.file);
  const settings: RawRule[] = [
    { settings: { foreground: data.colors['editor.foreground'] ?? DEFAULT_FOREGROUND[kind], background: data.colors['editor.background'] } },
    ...data.tokenColors.filter((r) => r && typeof r === 'object' && r.settings),
    ...customizations(found.name),
  ];
  return { name: found.name, theme: { name: found.name, settings } };
}

/** Queues highlight requests; reloads when the theme, extensions or settings change */
export class SyntaxHighlighter implements vscode.Disposable {
  private readonly grammars = new GrammarIndex();
  private tm: TextMateHighlighter | undefined;
  private ready: Promise<boolean> | undefined;
  /** The active theme is loaded into tm; right after a theme switch peek must not return old colors */
  private themeLoaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fired when the theme changes: phantom lines already drawn must be redrawn */
  readonly onDidChangeTheme = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  themeName: string | undefined;

  constructor(
    private readonly wasmPath: string,
    private readonly log: (m: string) => void,
  ) {
    this.disposables.push(
      this.emitter,
      vscode.window.onDidChangeActiveColorTheme(() => this.reload()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('editor.tokenColorCustomizations') || e.affectsConfiguration('workbench.colorTheme')) this.reload();
      }),
      vscode.extensions.onDidChange(() => {
        this.grammars.rebuild();
        this.reload();
      }),
    );
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('ccReview').get<boolean>('syntaxHighlight', true);
  }

  private reload(): void {
    this.ready = undefined;
    this.themeLoaded = false;
    this.emitter.fire();
  }

  private ensure(): Promise<boolean> {
    this.ready ??= (async () => {
      try {
        const t = await loadActiveTheme();
        if (!t) {
          this.log('Theme file for the active theme not found; phantom lines stay uncolored');
          return false;
        }
        this.themeName = t.name;
        if (this.tm) this.tm.setTheme(t.theme);
        else this.tm = new TextMateHighlighter(this.wasmPath, this.grammars, t.theme);
        this.themeLoaded = true;
        return true;
      } catch (e) {
        this.log(`Failed to load the theme; phantom lines stay uncolored: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    })();
    return this.ready;
  }

  /** Color lines [from, from + count) of the baseline `lines`; undefined if there is no grammar for the language */
  highlight(docKey: string, hash: string, languageId: string, lines: readonly string[], from: number, count: number): Promise<StyledSpan[][] | undefined> {
    const run = async () => {
      if (!this.enabled || count <= 0) return undefined;
      const scope = this.grammars.scopeForLanguage(languageId);
      if (!scope || !(await this.ensure()) || !this.tm) return undefined;
      return this.tm.highlight(docKey, hash, scope, lines, from, count);
    };
    const p = this.queue.then(run, run).catch((e: unknown) => {
      this.log(`Syntax highlighting failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    this.queue = p;
    return p;
  }

  /** Returns synchronously when already tokenized, so phantom lines are created with colors */
  peek(docKey: string, hash: string, languageId: string, lines: readonly string[], from: number, count: number): StyledSpan[][] | undefined {
    if (!this.enabled || !this.tm || !this.themeLoaded || count <= 0) return undefined;
    const scope = this.grammars.scopeForLanguage(languageId);
    return scope ? this.tm.peek(docKey, hash, scope, lines, from, count) : undefined;
  }

  dispose(): void {
    this.tm?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
