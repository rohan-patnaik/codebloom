// Dev only: map Go and Rust through real language servers.
// Usage: env -u ELECTRON_RUN_AS_NODE node test/integration/real-lsp.cjs <tmp-dir>
// <tmp-dir> holds ext/ (golang.go, rust-analyzer), ud/ (settings) and ws/{go,rust}.
const path = require('path');
const { runTests } = require('@vscode/test-electron');
(async () => {
  const root = path.resolve(__dirname, '../..');
  const tmp = process.argv[2];
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'real-lsp-suite.cjs'),
      launchArgs: [path.join(tmp, 'ws'), '--extensions-dir', path.join(tmp, 'ext'), '--user-data-dir', path.join(tmp, 'ud'), '--skip-welcome', '--skip-release-notes'],
    });
  } catch (e) {
    console.error('Real language server tests failed', e);
    process.exit(1);
  }
})();
