// Three entry points: the extension, the hook that Claude Code runs, and the integration tests
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  logLevel: 'info',
  minify: production,
  sourcemap: production ? false : 'linked',
  // Prefer each package's ESM entry: jsonc-parser's UMD build has dynamic requires that esbuild cannot bundle
  mainFields: ['module', 'main'],
};

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  // The hook cold-starts twice per edit: no minification, no sourcemap, Node built-ins only
  { ...common, entryPoints: ['src/hook/hook.ts'], outfile: 'dist/hook.js', minify: false, sourcemap: false },
];
if (!production) {
  builds.push({ ...common, entryPoints: ['test/integration/suite.ts'], outfile: 'dist/test/suite.js', external: ['vscode'] });
}

// Oniguruma (regex engine) WASM for syntax highlighting, loaded from this path at runtime
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync('node_modules/vscode-oniguruma/release/onig.wasm', 'dist/onig.wasm');

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
