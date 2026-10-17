// Merge / remove our hooks in ~/.claude/settings.json. Pure functions: inputs are not mutated, no file system access.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HookSpec {
  /** Absolute path of the node executable (exec form, independent of Claude Code's PATH) */
  node: string;
  /** ~/.cc-review/hook.js */
  script: string;
  trackBash: boolean;
}

type Settings = Record<string, any>;

/** The tools that write files by path */
export const EDIT_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

/** Our hooks: event, matcher, hook.js mode */
function ourHookList(trackBash: boolean): Array<[event: string, matcher: string | undefined, mode: string]> {
  return [
    ['PreToolUse', EDIT_MATCHER, 'pre'],
    ['PostToolUse', EDIT_MATCHER, 'post'],
    ['UserPromptSubmit', undefined, 'prompt'],
    ['Stop', undefined, 'stop'],
    ...(trackBash
      ? ([
          ['PreToolUse', 'Bash', 'bash-pre'],
          ['PostToolUse', 'Bash', 'bash-post'],
        ] as Array<[string, string, string]>)
      : []),
  ];
}

/** Recognize our own entries by the hook.js path */
export function isOurHook(h: unknown, script: string): boolean {
  if (!h || typeof h !== 'object') return false;
  const o = h as { args?: unknown; command?: unknown };
  const mentions = (s: unknown) => typeof s === 'string' && (s === script || s.includes('/.cc-review/hook.js'));
  return (Array.isArray(o.args) && o.args.some(mentions)) || mentions(o.command);
}

export function removeOurHooks(settings: Settings | undefined, script: string): Settings {
  const out: Settings = structuredClone(settings ?? {});
  const hooks = out.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return out;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: any[] = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const remaining = g.hooks.filter((h: unknown) => !isOurHook(h, script));
      if (remaining.length === g.hooks.length) kept.push(g);
      else if (remaining.length > 0) kept.push({ ...g, hooks: remaining });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

export function addOurHooks(settings: Settings | undefined, spec: HookSpec): Settings {
  const out = removeOurHooks(settings, spec.script);
  if (!out.hooks || typeof out.hooks !== 'object' || Array.isArray(out.hooks)) out.hooks = {};
  for (const [event, matcher, mode] of ourHookList(spec.trackBash)) {
    if (!Array.isArray(out.hooks[event])) out.hooks[event] = [];
    const hook = { type: 'command', command: spec.node, args: [spec.script, mode], timeout: 10 };
    out.hooks[event].push(matcher === undefined ? { hooks: [hook] } : { matcher, hooks: [hook] });
  }
  return out;
}

/**
 * missing: the hooks that record Claude's edits are not all there.
 * outdated: they are, but not exactly as this version installs them (e.g. no Stop hook, the Edit
 * matcher without NotebookEdit, or no Bash hooks while ccReview.trackBash is on).
 */
export type HookStatus = 'missing' | 'outdated' | 'current';

export function ourHookStatus(settings: Settings | undefined, script: string, trackBash: boolean): HookStatus {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return 'missing';
  const has = (event: string, mode: string, matcher?: string | null) =>
    Array.isArray(hooks[event]) &&
    hooks[event].some(
      (g: any) =>
        Array.isArray(g?.hooks) &&
        (matcher === null || g.matcher === matcher) &&
        g.hooks.some((h: any) => isOurHook(h, script) && Array.isArray(h.args) && h.args.includes(mode)),
    );
  if (!(has('PreToolUse', 'pre', null) && has('PostToolUse', 'post', null) && has('UserPromptSubmit', 'prompt', null))) return 'missing';
  return ourHookList(trackBash).every(([event, matcher, mode]) => has(event, mode, matcher)) ? 'current' : 'outdated';
}

export function detectIndent(text: string): string | number {
  const m = /^[ \t]+(?=")/m.exec(text);
  if (!m) return 2;
  return m[0].includes('\t') ? '\t' : m[0].length;
}
