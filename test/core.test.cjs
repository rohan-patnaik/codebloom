// Unit tests for the parser + resolver. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Parsers, Project, langOf } = require('../dist-test/core.js');

const FIX = path.join(__dirname, 'fixtures');
let project;

test.before(async () => {
  const parsers = await Parsers.create(path.join(__dirname, '..', 'dist'));
  project = new Project();
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (langOf(p)) project.set(parsers.parse(path.relative(FIX, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf8')));
    }
  })(FIX);
});

const find = (v, name) => {
  const stack = [...v.blocks];
  while (stack.length) {
    const b = stack.shift();
    if (b.qual === name) return b;
    stack.push(...b.children);
  }
  throw new Error('no block ' + name);
};
const outs = (v, name) => v.links[find(v, name).id]?.out.map((r) => `${r.rel}:${r.label}`) ?? [];
const ins = (v, name) => v.links[find(v, name).id]?.in.map((r) => `${r.rel}:${r.label}`) ?? [];

test('python: blocks, comments and ranges', () => {
  const v = project.view('py/pkg/engine.py');
  assert.deepStrictEqual(v.blocks.map((b) => b.kind), ['doc', 'imports', 'class', 'class', 'function']);
  const engine = find(v, 'Engine');
  assert.strictEqual(engine.start, 13, 'leading comment belongs to the class');
  assert.deepStrictEqual(engine.children.map((c) => c.name), ['fields', '__init__', 'run']);
  assert.strictEqual(find(v, 'helper.inner').kind, 'function');
});

test('python: self, inheritance, imports, module vars and typed params', () => {
  const e = project.view('py/pkg/engine.py');
  assert.deepStrictEqual(outs(e, 'Engine.run').sort(), ['py/pkg/engine.py:Base.start', 'py/pkg/engine.py:helper']);
  const m = project.view('py/main.py');
  const go = outs(m, 'go');
  assert.ok(go.includes('py/pkg/engine.py:Engine.run'));
  assert.ok(go.includes('py/pkg/engine.py:helper'), 'aliased from-import');
  assert.ok(go.includes('py/pkg/engine.py:Engine.__init__'), 're-export through __init__.py');
});

test('javascript: imports, default export, require, this.field typing', () => {
  const v = project.view('js/app.js');
  const run = outs(v, 'run');
  assert.ok(run.includes('js/lib/store.js:Store.constructor'));
  assert.ok(run.includes('js/lib/store.js:Store.add'), 'typed local var');
  assert.ok(run.includes('js/util.js:sum'), 'require namespace');
  const s = project.view('js/lib/store.js');
  assert.deepStrictEqual(outs(s, 'Store.add'), ['js/lib/store.js:Logger.write']);
});

test('java: same package, imports, static imports, fields, inheritance', () => {
  const v = project.view('java/com/acme/core/Engine.java');
  assert.deepStrictEqual(outs(v, 'Engine.run').sort(), [
    'java/com/acme/core/Base.java:Base.prepare',
    'java/com/acme/core/Engine.java:Logger.write',
    'java/com/acme/core/Util.java:Util.twice',
  ]);
  const m = project.view('java/com/acme/app/Main.java');
  const main = outs(m, 'Main.main');
  assert.ok(main.includes('java/com/acme/core/Engine.java:Engine.Engine'));
  assert.ok(main.includes('java/com/acme/core/Engine.java:Engine.run'));
  assert.ok(main.includes('java/com/acme/core/Util.java:Util.twice'), 'static import');
  assert.ok(main.includes('java/com/acme/app/Main.java:Main.go'), 'new X().m()');
});

test('updates replace a file and re-resolve', async () => {
  const parsers = await Parsers.create(path.join(__dirname, '..', 'dist'));
  const p = new Project();
  p.set(parsers.parse('a.py', 'def f():\n    g()\n'));
  assert.deepStrictEqual(p.view('a.py').links[find(p.view('a.py'), 'f').id].ext, ['g']);
  p.set(parsers.parse('a.py', 'def f():\n    g()\n\ndef g():\n    pass\n'));
  assert.deepStrictEqual(outs(p.view('a.py'), 'f'), ['a.py:g']);
});
