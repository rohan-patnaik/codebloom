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

const refs = (v, name) => v.links[find(v, name).id]?.refs.map((r) => `${r.rel}:${r.label}`) ?? [];

test('python: functions passed as values are "referenced by", not unused', () => {
  const v = project.view('py/graph.py');
  assert.deepStrictEqual(ins(v, 'plan_node'), [], 'never called directly');
  assert.deepStrictEqual(refs(v, 'plan_node'), ['py/graph.py:build'], 'add_node and the dict count once');
  assert.deepStrictEqual(refs(v, 'review_node'), ['py/graph.py:build']);
  assert.deepStrictEqual(find(v, 'review_node').decorators, ['@app.route("/review")']);
  assert.deepStrictEqual(outs(v, 'plan_node'), ['py/pkg/engine.py:helper'], 'calls still resolve');
  assert.ok(!v.links[find(v, 'build').id].ext.includes('plan_node'), 'references are not unlinked calls');
});

test('javascript: handlers, bind and shorthand properties are references', () => {
  const v = project.view('js/ui.js');
  assert.deepStrictEqual(refs(v, 'View.onClick'), ['js/ui.js:View.constructor'], 'this.onClick.bind(this)');
  assert.deepStrictEqual(refs(v, 'View.onKey'), ['js/ui.js:View.constructor']);
  const save = refs(v, 'save').map((r) => r.replace(/#globals@\d+/, '#globals'));
  assert.ok(save.includes('js/ui.js:wire'), save.join(','));
  assert.ok(save.some((r) => r.includes('#globals')), 'shorthand { save }');
  assert.ok(!v.links[find(v, 'View.constructor').id].ext.some((e) => e.includes('bind')));
});

test('grammars load on first use', async () => {
  const parsers = await Parsers.create(path.join(__dirname, '..', 'dist'), []);
  assert.strictEqual(parsers.loaded('python'), false);
  const g = await parsers.parseAsync('x.py', 'def f():\n    pass\n');
  assert.strictEqual(g.engine, 'parser');
  assert.strictEqual(parsers.loaded('python'), true);
  assert.strictEqual(parsers.loaded('java'), false);
  assert.throws(() => parsers.parse('X.java', 'class X {}'), /not loaded/);
});

const { symbolGraph, nestSymbols, wholeFileGraph } = require('../dist-test/core.js');
const span = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
const sym = (name, kind, r, sel, children = [], detail = '') => ({ name, kind, range: span(...r), selectionRange: span(...sel), children, detail });

test('symbols: a TypeScript-style outline becomes blocks', () => {
  const lines = [
    "import { a } from './a';",
    "import b from 'b';",
    '',
    'export class Store {',
    '  private items: string[] = [];',
    '  size = 0;',
    '  add(x: string): void {',
    '    const y = 1;',
    '  }',
    '}',
    'export const handler = (e: Event) => {',
    '  go(e);',
    '};',
    'const LIMIT = 3;',
    'const NAME = "x";',
  ];
  // vscode.SymbolKind: Class 4, Method 5, Property 6, Variable 12, Constant 13.
  const g = symbolGraph('src/store.ts', 'typescript', lines, [
    sym('Store', 4, [3, 0, 9, 1], [3, 13, 3, 18], [
      sym('items', 6, [4, 2, 4, 30], [4, 10, 4, 15]),
      sym('size', 6, [5, 2, 5, 11], [5, 2, 5, 6]),
      sym('add', 5, [6, 2, 8, 3], [6, 2, 6, 5], [sym('y', 13, [7, 10, 7, 15], [7, 10, 7, 11])]),
    ]),
    sym('handler', 12, [10, 13, 12, 1], [10, 13, 10, 20]),
    sym('LIMIT', 13, [13, 6, 13, 15], [13, 6, 13, 11]),
    sym('NAME', 13, [14, 6, 14, 16], [14, 6, 14, 10]),
  ]);
  assert.strictEqual(g.engine, 'symbols');
  assert.deepStrictEqual(g.blocks.map((b) => `${b.kind}:${b.name}`), ['imports:imports', 'class:Store', 'function:handler', 'globals:globals']);
  assert.strictEqual(g.blocks[0].detail, './a, b');
  assert.deepStrictEqual([g.blocks[0].start, g.blocks[0].end], [1, 2]);
  const store = g.blocks[1];
  assert.deepStrictEqual([store.start, store.end, store.defLine, store.defCol], [4, 10, 4, 13]);
  assert.deepStrictEqual(store.children.map((c) => `${c.kind}:${c.name}`), ['fields:fields', 'method:add']);
  assert.strictEqual(store.children[0].detail, 'items, size');
  assert.deepStrictEqual(store.children[1].children, [], 'locals inside a method are dropped');
  assert.strictEqual(store.children[1].signature, '(x: string): void');
  assert.strictEqual(g.blocks[3].detail, 'LIMIT, NAME');
});

test('symbols: tags, flat providers and the whole-file fallback', () => {
  const md = symbolGraph('README.md', 'markdown', ['# A', 'text', '## B', 'more'], [
    sym('A', 14, [0, 0, 3, 4], [0, 0, 0, 3], [sym('B', 14, [2, 0, 3, 4], [2, 0, 2, 4])]),
  ]);
  assert.strictEqual(md.blocks[0].kind, 'section');
  assert.strictEqual(md.blocks[0].tag, 'heading');
  assert.strictEqual(md.blocks[0].children[0].kind, 'section', 'headings nest even without their own children');
  const go = symbolGraph('main.go', 'go', ['package main', '', 'import (', '\t"fmt"', '\t"os"', ')', '', 'type Server struct {', '}'], [
    sym('Server', 22, [7, 0, 8, 1], [7, 5, 7, 11]),
  ]);
  assert.strictEqual(go.blocks[0].kind, 'imports');
  assert.deepStrictEqual([go.blocks[0].start, go.blocks[0].end], [1, 6]);
  assert.strictEqual(go.blocks[0].detail, 'main, fmt, os');
  assert.strictEqual(go.blocks[1].tag, 'struct');
  const nested = nestSymbols([
    sym('m', 5, [2, 2, 3, 3], [2, 2, 2, 3]),
    sym('C', 4, [1, 0, 4, 1], [1, 6, 1, 7]),
    sym('f', 11, [6, 0, 7, 1], [6, 9, 6, 10]),
  ]);
  assert.deepStrictEqual(nested.map((s) => `${s.name}(${s.children.map((c) => c.name)})`), ['C(m)', 'f()']);
  const whole = wholeFileGraph('a.zig', 'zig', 40);
  assert.deepStrictEqual([whole.blocks.length, whole.blocks[0].start, whole.blocks[0].end], [1, 1, 40]);
});

test('highlighter: language families colour without a grammar', () => {
  const { highlight } = require('../dist-test/highlight.js');
  const [go] = highlight(['func main() { // hi'], 'go');
  assert.match(go, /t-k">func</);
  assert.match(go, /t-c">\/\/ hi</);
  const [rb] = highlight(['def x # note'], 'ruby');
  assert.match(rb, /t-c"># note</);
  const [css] = highlight(['#main { color: red; }'], 'css');
  assert.doesNotMatch(css, /t-c/, 'a CSS id is not a comment');
  const [md] = highlight(["It's fine"], 'markdown');
  assert.doesNotMatch(md, /t-s/, 'apostrophes are not strings in Markdown');
});

test('jsx: handlers in props are references', async () => {
  const parsers = await Parsers.create(path.join(__dirname, '..', 'dist'), ['javascript']);
  const p = new Project();
  p.set(parsers.parse('a.jsx', 'function go() {}\nfunction App() {\n  return <b onClick={go} />;\n}\n'));
  assert.deepStrictEqual(refs(p.view('a.jsx'), 'go'), ['a.jsx:App']);
});
