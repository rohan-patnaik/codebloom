const vscode = require('vscode');
const assert = require('assert');
const path = require('path');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(100);
  }
}

exports.run = async function () {
  const root = vscode.workspace.workspaceFolders[0].uri;
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'codebloom');
  assert.ok(ext, 'extension found');
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push('ok   ' + name); } catch (e) { results.push('FAIL ' + name + ': ' + e.message); }
  };

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'py/main.py'));
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('codebloom.openMap');
  const api = await ext.activate();

  await check('panel opens', async () => {
    await until(() => api.panel());
  });
  await check('workspace index links across files', async () => {
    await until(() => !api.service.project.indexing && api.service.project.fileCount >= 10, 20000);
    const v = api.service.project.view('py/main.py');
    const go = v.blocks.find((b) => b.name === 'go');
    const outs = v.links[go.id].out.map((r) => r.rel + ':' + r.label);
    assert.ok(outs.includes('py/pkg/engine.py:Engine.run'), outs.join(','));
  });
  await check('java and js are parsed', async () => {
    const j = api.service.project.view('java/com/acme/app/Main.java');
    assert.ok(j.blocks.some((b) => b.name === 'Main'));
    const js = api.service.project.view('js/app.js');
    assert.ok(js.blocks.some((b) => b.name === 'run'));
  });
  await check('live edits update the map', async () => {
    const ed = vscode.window.activeTextEditor;
    await ed.edit((e) => e.insert(new vscode.Position(doc.lineCount, 0), '\n\ndef added_later():\n    go(None)\n'));
    await until(() => api.service.project.view('py/main.py').blocks.some((b) => b.name === 'added_later'), 5000);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });
  await check('map follows the active editor', async () => {
    const js = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'js/app.js'));
    await vscode.window.showTextDocument(js, vscode.ViewColumn.One);
    await until(() => api.panel() && api.panel().panel.title.includes('app.js'), 5000);
  });
  await check('copy block context', async () => {
    const ed = vscode.window.activeTextEditor;
    ed.selection = new vscode.Selection(6, 0, 6, 0);
    await vscode.commands.executeCommand('codebloom.copyBlockContext');
    const text = await vscode.env.clipboard.readText();
    assert.ok(text.includes(':: run') && text.includes('Calls:'), text);
  });
  console.log('\n' + results.join('\n') + '\n');
  if (results.some((r) => r.startsWith('FAIL'))) throw new Error('integration failures');
};
