// Launches a real VS Code with the extension and runs suite.cjs inside it.
const path = require('path');
const { runTests } = require('@vscode/test-electron');
(async () => {
  const root = path.resolve(__dirname, '../..');
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.cjs'),
      launchArgs: [path.join(root, 'test/fixtures'), '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
    });
  } catch (e) {
    console.error('Integration tests failed', e);
    process.exit(1);
  }
})();
