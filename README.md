# Claude Code Review (Keep / Undo)

Review the files Claude Code edits change by change, the way Copilot does: added lines on a green background, deleted lines shown as red "phantom" lines highlighted with your theme, and Keep | Undo above every change. Claude writes to disk as usual and you review afterwards. You can group changes by the prompt that produced them, and ask Claude about any single change.

There is one rule: a file is pending as long as it differs from its baseline. Keep updates the baseline; Undo updates the file.

## Install

Requires VS Code 1.140 or later (the stable release is fine; Insiders is not needed) and Node (for the hooks).

1. Build and install the extension:

   ```sh
   cd cc-review
   npm install
   npm run package
   code --install-extension cc-review-0.1.0.vsix
   ```

2. Allow the proposed API: run **Preferences: Configure Runtime Arguments** from the Command Palette, add this line to `argv.json`, then quit VS Code completely and reopen it:

   ```jsonc
   "enable-proposed-api": ["local.cc-review"]
   ```

   Without it the extension still works, but deleted lines are only marked in the gutter and shown on hover.

3. Install the hooks: the extension offers this on first start, or run **Claude Review: Install Claude Code Hooks** from the Command Palette. It first shows a diff of the change to `~/.claude/settings.json` and writes only after you confirm. It only appends 3 hooks, leaves your existing settings alone, and backs up the original file as `settings.json.cc-review.bak`. Claude Code picks up the change automatically.

## Usage

| Action | How |
| --- | --- |
| Keep / Undo one change | The CodeLens above the change; the buttons at the top right of the phantom lines (shown on hover); ⌃⌥K / ⌃⌥U with the cursor in the change |
| Previous / next change (across files) | ⌃⌥P / ⌃⌥N, or the arrows in the editor title bar |
| Keep / Undo a whole file | The buttons in the editor title bar, or on the file's row in the Claude Changes view |
| See all changes | Click "Claude: N files · M changes" in the status bar to open a multi-file diff |
| Keep / Undo everything | The title bar buttons of the Claude Changes view in the Source Control sidebar |
| Ask Claude about a change | "Ask Claude" above the change; the button on the phantom lines; ⌃⌥C with the cursor in the change |
| Group by prompt | The clock icon in the Claude Changes view's title bar switches to **Group by Prompt**: each message you sent → files → changes |
| Keep / Undo everything from one prompt | When grouped by prompt, the buttons on a prompt's row or on a file row under it |
| See what one prompt changed | The diff button on a prompt's row, or **Show Changes from Recent Prompts** in the view's menu (includes prompts already fully reviewed) |

- Undo is applied as an editor edit and saved right away, so ⌘Z brings the change back. If you ⌘Z the Undo of the last change in a file, that change becomes pending again.
- Your own edits in a pending file are merged into the baseline automatically as long as they are outside Claude's changes (an automatic Keep), so they are not mistaken for Claude's. Turn this off with `ccReview.autoKeepUserEdits`.
- The next time you send Claude a message, the hook tells it which changes you undid, so it does not add them back.
- For a file Claude created, Undo deletes the file (it moves to the Trash, after you confirm).
- Phantom lines are colored with the same TextMate grammars and active theme as the editor, and follow theme switches. Deleted lines in the middle of a block comment or template string are colored correctly too.
- Each change is labeled with the message it came from (the quoted text at the end of its CodeLens). Attribution traces lines through snapshots: if a later prompt edits lines an earlier prompt added, they belong to the later prompt; lines you add yourself between prompts are not counted as Claude's.
- "Ask Claude" opens Claude Code with `@file#lines` and the change's original content prefilled (prefilled only, not sent), in the session that made the change. If that session is not in the current workspace, it starts a new conversation.
- A git checkout, a Claude Code rewind, or changing the lines back by hand all take the file off the queue automatically.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ccReview.autoKeepUserEdits` | `true` | Merge your edits outside Claude's changes into the baseline automatically |
| `ccReview.phantomLines` | `inset` | How deleted lines are shown: `inset` (red phantom lines between the code lines) or `hover` |
| `ccReview.maxInsetsPerEditor` | `20` | Maximum number of phantom line insets in one editor at a time |
| `ccReview.maxFileSizeKB` | `1024` | Larger files can only be kept or undone as a whole |
| `ccReview.showFilesOutsideWorkspace` | `false` | Also show files outside the workspace that Claude changed |
| `ccReview.codeLens` | `true` | Show Keep \| Undo above each change |
| `ccReview.syntaxHighlight` | `true` | Syntax-highlight phantom lines with the active theme |
| `ccReview.groupBy` | `file` | Group the Claude Changes view by file (`file`) or by prompt (`round`) |
| `ccReview.nodePath` | auto | Absolute path of the node the hooks run with |
| `ccReview.trackBash` | `false` | (Experimental) Also capture files changed by Bash commands; reinstall the hooks after changing it |

To keep files from being copied into `~/.cc-review/`, list them in `~/.cc-review/.ccreviewignore` (global) or in a `.ccreviewignore` in your project, using `.gitignore` syntax. `.env`, `*.pem`, `*.key` and similar files are ignored by default.

## How it works

```text
Claude Code ──hook.js──▶ ~/.cc-review/ ◀──watches── VS Code extension ──▶ decorations, phantom lines, Keep / Undo in the editor
                              ▲                          │
                              └──── reverts.jsonl ◀──────┘ (Undo records, passed back to Claude with your next message)
```

| Hook | What it does |
| --- | --- |
| `PreToolUse(Edit\|Write\|MultiEdit)` | Stages the file's current content in `staging/<tool_use_id>` |
| `PostToolUse(Edit\|Write\|MultiEdit)` | After a successful write, turns the staged content into the baseline if the file has none yet (first touch); appends a write event |
| `UserPromptSubmit` | Records the prompt for this round; prints this session's unreported Undo records to stdout, which Claude receives as context |

Within each round (one `prompt_id`), Post also keeps two snapshots of every file it changes: before the round's first write and after its last write. The extension walks the snapshot chain back from the current content to work out which prompt introduced each change.

```text
~/.cc-review/
  hook.js             copied here when the extension starts, so its path never changes
  .ccreviewignore     global ignore rules
  baselines/<sha1(path)>.json / .base   baseline metadata and content
  staging/            original content staged by Pre, removed after Post
  events.jsonl        one line per write by Claude
  reverts.jsonl       one line per Undo
  reported/           Undo records already reported, per session
  rounds/<prompt_id>/ round.json (your prompt, truncated to 500 characters); <sha1>.before / .after (snapshots before and after the round)
  hook.log            hook error log
```

The hooks always exit 0 and never print JSON, so they never affect Claude Code's permission decisions. Each edit runs two extra node processes of about 50 ms each.

Prompt text is stored only on your machine, in `~/.cc-review/rounds/` (Claude Code keeps its own transcripts locally too). A round is deleted once it is more than a day old and none of its files are pending, or once it is more than 7 days old.

## Development

```sh
cd cc-review
npm install
npm run build              # dist/extension.js, dist/hook.js
npm test                   # unit + hook tests (vitest, 99)
npm run test:integration   # integration tests in a separate VS Code instance (26)
npm run package            # build the VSIX
```

Open the `cc-review` folder in VS Code and press F5 to launch the Extension Development Host (`cc-review/.vscode/launch.json` already passes `--enable-proposed-api local.cc-review`).

Code under `cc-review/src/core/` does not import `vscode`. The integration tests use the VS Code installed on this machine (override with `VSCODE_PATH`) with a separate user data directory, and point `CC_REVIEW_HOME` and `CLAUDE_CONFIG_DIR` at temporary directories, so real data is never touched. To debug the hooks, set `CC_REVIEW_DEBUG=1`; raw hook input is logged to `~/.cc-review/hook-debug.jsonl`.

## Uninstall

Run **Claude Review: Remove Claude Code Hooks**, then uninstall the extension. You can delete `~/.cc-review/` afterwards.
