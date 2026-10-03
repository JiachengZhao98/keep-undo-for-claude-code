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
  const cmd = (mode: string) => ({ type: 'command', command: spec.node, args: [spec.script, mode], timeout: 10 });
  const add = (event: string, group: object) => {
    if (!Array.isArray(out.hooks[event])) out.hooks[event] = [];
    out.hooks[event].push(group);
  };
  add('PreToolUse', { matcher: 'Edit|Write|MultiEdit', hooks: [cmd('pre')] });
  add('PostToolUse', { matcher: 'Edit|Write|MultiEdit', hooks: [cmd('post')] });
  add('UserPromptSubmit', { hooks: [cmd('prompt')] });
  if (spec.trackBash) {
    add('PreToolUse', { matcher: 'Bash', hooks: [cmd('bash-pre')] });
    add('PostToolUse', { matcher: 'Bash', hooks: [cmd('bash-post')] });
  }
  return out;
}

/** Installed only when all three required hooks are present */
export function ourHooksInstalled(settings: Settings | undefined, script: string): boolean {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  const has = (event: string, mode: string) =>
    Array.isArray(hooks[event]) &&
    hooks[event].some(
      (g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => isOurHook(h, script) && Array.isArray(h.args) && h.args.includes(mode)),
    );
  return has('PreToolUse', 'pre') && has('PostToolUse', 'post') && has('UserPromptSubmit', 'prompt');
}

export function detectIndent(text: string): string | number {
  const m = /^[ \t]+(?=")/m.exec(text);
  if (!m) return 2;
  return m[0].includes('\t') ? '\t' : m[0].length;
}
