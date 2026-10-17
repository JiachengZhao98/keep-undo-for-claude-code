import { describe, expect, it } from 'vitest';
import { addOurHooks, detectIndent, ourHookStatus, removeOurHooks } from '../../src/install/hookConfig';

const SCRIPT = '/Users/me/.cc-review/hook.js';
const spec = { node: '/opt/homebrew/bin/node', script: SCRIPT, trackBash: false };

// Same shape as a real ~/.claude/settings.json: existing HTTP hooks and other settings
const existing = {
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: '', hooks: [{ type: 'http', url: 'http://127.0.0.1:19847/hook/x/pre-tool-use', timeout: 3 }] }],
    UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'http', url: 'http://127.0.0.1:19847/hook/x/ups', timeout: 3 }] }],
    SessionEnd: [{ matcher: '__disabled__', hooks: [{ type: 'command', command: 'npx claude-receipts generate', timeout: 30 }] }],
  },
};

describe('hook config merging', () => {
  it('appends only our four hooks and leaves existing hooks and settings alone', () => {
    const out = addOurHooks(existing, spec);
    expect(out.model).toBe('opus');
    expect(out.hooks.PreToolUse).toHaveLength(2);
    expect(out.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(out.hooks.PreToolUse[1]).toEqual({
      matcher: 'Edit|Write|MultiEdit|NotebookEdit',
      hooks: [{ type: 'command', command: '/opt/homebrew/bin/node', args: [SCRIPT, 'pre'], timeout: 10 }],
    });
    expect(out.hooks.PostToolUse).toHaveLength(1);
    expect(out.hooks.UserPromptSubmit).toHaveLength(2);
    expect(out.hooks.UserPromptSubmit[1].matcher).toBeUndefined();
    expect(out.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: '/opt/homebrew/bin/node', args: [SCRIPT, 'stop'], timeout: 10 }] }]);
    expect(out.hooks.SessionEnd).toEqual(existing.hooks.SessionEnd);
    expect(ourHookStatus(out, SCRIPT, false)).toBe('current');
    expect(ourHookStatus(existing, SCRIPT, false)).toBe('missing');
  });

  it('reports hooks installed before the Stop hook existed as outdated, and updating adds only that hook', () => {
    const old = addOurHooks(existing, spec);
    delete old.hooks.Stop;
    expect(ourHookStatus(old, SCRIPT, false)).toBe('outdated');
    const updated = addOurHooks(old, spec);
    expect(ourHookStatus(updated, SCRIPT, false)).toBe('current');
    expect({ ...updated.hooks, Stop: undefined }).toEqual({ ...old.hooks, Stop: undefined });
  });

  it('is idempotent', () => {
    const once = addOurHooks(existing, spec);
    expect(addOurHooks(once, spec)).toEqual(once);
  });

  it('restores the original on removal', () => {
    expect(removeOurHooks(addOurHooks(existing, spec), SCRIPT)).toEqual(existing);
    expect(removeOurHooks(addOurHooks({}, spec), SCRIPT)).toEqual({});
  });

  it('does not mutate its input', () => {
    const copy = structuredClone(existing);
    addOurHooks(existing, spec);
    expect(existing).toEqual(copy);
  });

  it('adds two Bash hooks with trackBash', () => {
    const out = addOurHooks({}, { ...spec, trackBash: true });
    expect(out.hooks.PreToolUse.map((g: { matcher: string }) => g.matcher)).toEqual(['Edit|Write|MultiEdit|NotebookEdit', 'Bash']);
    expect(ourHookStatus(out, SCRIPT, true)).toBe('current');
    expect(removeOurHooks(out, SCRIPT)).toEqual({});
  });

  it('reports hooks as outdated when Bash tracking is on but its hooks are missing, or the Edit matcher is older', () => {
    const withoutBash = addOurHooks({}, spec);
    expect(ourHookStatus(withoutBash, SCRIPT, false)).toBe('current');
    expect(ourHookStatus(withoutBash, SCRIPT, true)).toBe('outdated');
    const oldMatcher = structuredClone(withoutBash);
    oldMatcher.hooks.PreToolUse[0].matcher = 'Edit|Write|MultiEdit';
    expect(ourHookStatus(oldMatcher, SCRIPT, false)).toBe('outdated');
  });

  it("keeps the file's indentation", () => {
    expect(detectIndent('{\n    "a": 1\n}')).toBe(4);
    expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t');
    expect(detectIndent('{}')).toBe(2);
  });
});
