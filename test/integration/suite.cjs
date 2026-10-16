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
  await check('open in new tab moves the map into the code\'s editor group', async () => {
    const js = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'js/app.js'));
    const ed = await vscode.window.showTextDocument(js, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('codebloom.openMapInTab');
    await until(() => api.panel()?.panel.viewColumn === ed.viewColumn && api.panel().panel.active, 5000);
    // Put things back the way the remaining checks expect: code in one, map beside it.
    api.panel().panel.reveal(vscode.ViewColumn.Two, true);
    await until(() => api.panel().panel.viewColumn === vscode.ViewColumn.Two, 5000);
    await vscode.window.showTextDocument(js, vscode.ViewColumn.One);
  });
  await check('copy block context', async () => {
    const ed = vscode.window.activeTextEditor;
    ed.selection = new vscode.Selection(6, 0, 6, 0);
    await vscode.commands.executeCommand('codebloom.copyBlockContext');
    const text = await vscode.env.clipboard.readText();
    assert.ok(text.includes(':: run') && text.includes('Calls:'), text);
  });
  await check('typescript maps from the built-in language server', async () => {
    const ts = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'ts/shop.ts'));
    await vscode.window.showTextDocument(ts, vscode.ViewColumn.One);
    await until(() => api.service.outlineOf('ts/shop.ts') === 'ok', 30000);
    const v = api.service.project.view('ts/shop.ts');
    assert.strictEqual(v.engine, 'symbols');
    const names = v.blocks.map((b) => b.kind + ':' + b.name);
    assert.ok(names.includes('imports:imports') && names.includes('class:Cart') && names.includes('function:checkout'), names.join(','));
    const cart = v.blocks.find((b) => b.name === 'Cart');
    assert.ok(cart.children.some((c) => c.kind === 'method' && c.name === 'add'), JSON.stringify(cart.children.map((c) => c.name)));
  });
  await check('typescript calls come from the call hierarchy', async () => {
    const v = api.service.project.view('ts/shop.ts');
    const checkout = v.blocks.find((b) => b.name === 'checkout');
    const info = await until(async () => {
      const i = await api.service.callsFor('ts/shop.ts', checkout.id);
      return i.status === 'ok' && i.out.length ? i : undefined;
    }, 20000);
    const outs = info.out.map((r) => r.label);
    assert.ok(outs.includes('add') && outs.includes('total'), outs.join(','));
    const add = v.blocks.find((b) => b.name === 'Cart').children.find((c) => c.name === 'add');
    assert.ok(info.out.some((r) => r.id === add.id), 'targets in the same file point at map blocks');
    const log = v.blocks.find((b) => b.name === 'log');
    const callers = await api.service.callsFor('ts/shop.ts', log.id);
    assert.ok(callers.in.some((r) => r.label === 'add'), JSON.stringify(callers.in));
  });
  for (const [rel, lang] of [['go/main.go', 'go'], ['rust/lib.rs', 'rust']]) {
    await check(`${lang} without a language extension falls back to one block`, async () => {
      await vscode.workspace.getConfiguration('codebloom').update('languages', [...vscode.workspace.getConfiguration('codebloom').get('languages'), lang], vscode.ConfigurationTarget.Global);
      const d = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, rel));
      await vscode.window.showTextDocument(d, vscode.ViewColumn.One);
      await until(() => api.service.outlineOf(rel) === 'waiting' || api.service.outlineOf(rel) === 'none', 10000);
      await until(() => api.service.outlineOf(rel) === 'none', 30000);
      const v = api.service.project.view(rel);
      assert.deepStrictEqual(v.blocks.map((b) => b.kind), ['script']);
      assert.strictEqual(v.blocks[0].end, d.lineCount);
    });
  }
  await check('languages can be switched on', async () => {
    const rb = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'ruby/app.rb'));
    assert.strictEqual(api.service.isSupported(rb), false, 'ruby is off by default');
    const cfg = vscode.workspace.getConfiguration('codebloom');
    await cfg.update('languages', [...cfg.get('languages'), 'ruby'], vscode.ConfigurationTarget.Global);
    assert.strictEqual(api.service.isSupported(rb), true);
    await cfg.update('languages', undefined, vscode.ConfigurationTarget.Global);
    assert.strictEqual(api.service.isSupported(rb), false);
    // Turning a parser language off drops its files from the index.
    await cfg.update('languages', ['python'], vscode.ConfigurationTarget.Global);
    await until(() => !api.service.project.indexing && api.service.project.fileCount > 0 && !api.service.project.has('js/app.js'), 20000);
    assert.ok(api.service.project.has('py/main.py'));
    await cfg.update('languages', undefined, vscode.ConfigurationTarget.Global);
  });
  console.log('\n' + results.join('\n') + '\n');
  if (results.some((r) => r.startsWith('FAIL'))) throw new Error('integration failures');
};
