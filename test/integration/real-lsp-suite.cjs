const vscode = require('vscode');
const assert = require('assert');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(250);
  }
}

exports.run = async function () {
  const root = vscode.workspace.workspaceFolders[0].uri;
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'codebloom');
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push('ok   ' + name); } catch (e) { results.push('FAIL ' + name + ': ' + e.message); }
  };
  const api = await ext.activate();
  const dump = (v) => v.blocks.map((b) => `${b.kind}:${b.name}${b.children.length ? '(' + b.children.map((c) => c.kind + ':' + c.name).join(',') + ')' : ''}`).join(' ');
  for (const [rel, fn, callee, langExt] of [['go/main.go', 'Start', 'greet', 'golang.go'], ['rust/src/main.rs', 'shift', 'helper', 'rust-lang.rust-analyzer']]) {
    await check(`${rel}: outline and calls from ${langExt}`, async () => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, rel));
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('codebloom.openMap');
      // Real servers can take a while on first start; keep re-mapping until the outline is there.
      await until(async () => {
        await api.service.update(doc);
        return api.service.outlineOf(rel) === 'ok';
      }, 120000);
      const v = api.service.project.view(rel);
      console.log(rel, '=>', dump(v));
      let block;
      for (const stack = [...v.blocks]; stack.length; ) {
        const b = stack.shift();
        if (b.name === fn || b.name.endsWith('.' + fn) || b.name.endsWith(')' + '.' + fn)) block = b;
        stack.push(...b.children);
      }
      assert.ok(block, `no ${fn} block in ${dump(v)}`);
      const info = await until(async () => {
        const i = await api.service.callsFor(rel, block.id);
        return i.status === 'ok' && i.out.length ? i : undefined;
      }, 60000);
      console.log(rel, fn, 'calls', info.out.map((r) => r.label + '@' + r.rel + ':' + r.line).join(', '));
      assert.ok(info.out.some((r) => r.label.includes(callee)), info.out.map((r) => r.label).join(','));
    });
  }
  console.log('\n' + results.join('\n') + '\n');
  if (results.some((r) => r.startsWith('FAIL'))) throw new Error('failures');
};
