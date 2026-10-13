import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
mkdirSync('dist', { recursive: true });
for (const [from, to] of [
  ['node_modules/web-tree-sitter/tree-sitter.wasm', 'dist/tree-sitter.wasm'],
  ['node_modules/tree-sitter-python/tree-sitter-python.wasm', 'dist/tree-sitter-python.wasm'],
  ['node_modules/tree-sitter-java/tree-sitter-java.wasm', 'dist/tree-sitter-java.wasm'],
  ['node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm', 'dist/tree-sitter-javascript.wasm'],
]) copyFileSync(from, to);

const alias = { 'web-tree-sitter': './node_modules/web-tree-sitter/tree-sitter.cjs' };
const common = { bundle: true, minify: production, sourcemap: !production, logLevel: 'info' };
const configs = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], alias },
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2020' },
  { ...common, entryPoints: ['src/webview/style.css'], outfile: 'dist/webview.css' },
];
if (!production) {
  configs.push({ ...common, sourcemap: false, entryPoints: ['src/core/index.ts'], outfile: 'dist-test/core.js', platform: 'node', format: 'cjs', target: 'node18', alias });
  configs.push({ ...common, sourcemap: false, entryPoints: ['src/webview/highlight.ts'], outfile: 'dist-test/highlight.js', platform: 'node', format: 'cjs', target: 'node18' });
}

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
