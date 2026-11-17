// Runs the integration tests in the locally installed VS Code with separate user-data and extensions
// directories and temp data directories, so neither your running VS Code nor the real ~/.cc-review
// and ~/.claude are touched.
import { runTests } from '@vscode/test-electron';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-it-')));
const workspace = path.join(tmp, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const resultFile = path.join(tmp, 'results.txt');

const vscodeExecutablePath = process.env.VSCODE_PATH || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

// When run from a VS Code terminal (or Claude Code's VS Code extension) these variables are inherited:
// ELECTRON_RUN_AS_NODE would start VS Code as plain node, and VSCODE_* would connect it to the outer instance
for (const k of Object.keys(process.env)) if (k.startsWith('ELECTRON_') || k.startsWith('VSCODE_')) delete process.env[k];

// The tests send real wheel and mouse input to the window, and read what it draws, over a debug port
const debugPort = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
// CCR_PERF=1 runs the performance scenarios (test/integration/perf.ts) instead of the tests
const perf = !!process.env.CCR_PERF;

let code = 0;
try {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'dist/test/suite.js'),
    launchArgs: [
      workspace,
      '--enable-proposed-api',
      'local.cc-review',
      '--disable-extensions',
      `--user-data-dir=${path.join(tmp, 'user-data')}`,
      `--extensions-dir=${path.join(tmp, 'extensions')}`,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      `--remote-debugging-port=${debugPort}`,
      // Keep rendering at full speed when another window covers this one, or the frame times mean nothing
      ...(perf ? ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] : []),
    ],
    extensionTestsEnv: {
      CC_REVIEW_HOME: path.join(tmp, 'cc-review-home'),
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
      CCR_WORKSPACE: workspace,
      CCR_RESULTS: resultFile,
      CCR_NO_TRASH: '1',
      // A regex: run only the tests whose names match
      CCR_ONLY: process.env.CCR_ONLY ?? (perf ? '^perf' : ''),
      CCR_PERF: perf ? '1' : '',
      CCR_CDP_PORT: String(debugPort),
      // A directory for screenshots of the window during the scenarios
      CCR_SHOTS: process.env.CCR_SHOTS ?? '',
    },
  });
} catch (e) {
  console.error('Integration tests failed:', e);
  code = 1;
}
if (fs.existsSync(resultFile)) console.log(fs.readFileSync(resultFile, 'utf8'));
// Clean up on success; keep everything on failure to inspect VS Code logs and the data directory
if (code === 0) fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`Temp directory (kept): ${tmp}`);
process.exit(code);
