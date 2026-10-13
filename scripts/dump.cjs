// Usage: node scripts/dump.cjs <root-dir> [file-to-show]
const fs = require('fs'), path = require('path');
const { Parsers, Project, langOf } = require('../dist-test/core.js');
(async () => {
  const root = process.argv[2], show = process.argv[3];
  const t0 = Date.now();
  const parsers = await Parsers.create(path.join(__dirname, '..', 'dist'));
  const project = new Project();
  const files = [];
  (function rec(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git', 'venv', '.venv', '__pycache__'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) rec(p); else if (langOf(p)) files.push(p); } })(root);
  const t1 = Date.now();
  for (const f of files) { const g = parsers.parse(path.relative(root, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')); if (g) project.set(g); }
  const t2 = Date.now();
  const views = show ? [project.view(show)] : files.map((f) => project.view(path.relative(root, f).split(path.sep).join('/')));
  const t3 = Date.now();
  console.error(`${files.length} files: init ${t1 - t0}ms, parse ${t2 - t1}ms, resolve+view ${t3 - t2}ms, links ${views[0]?.stats.links}`);
  if (process.env.QUIET) return;
  for (const v of views) {
    console.log(`@ ${v.rel} (${v.lineCount}L) ${v.summary ?? ''}`);
    const pr = (bs, d) => { for (const b of bs) { const l = v.links[b.id]; const o = l ? l.out.map((r) => (r.rel === v.rel ? '' : r.rel + ':') + r.label).join(', ') : ''; console.log(`${'  '.repeat(d + 1)}${b.kind} ${b.name} [${b.start}-${b.end}]${b.signature ? ' ' + b.signature : ''}${b.detail ? ' "' + b.detail + '"' : ''}${l?.in.length ? ' ←' + l.in.length : ''}${o ? ' → ' + o : ''}${l?.ext.length && process.env.EXT ? ' ext: ' + l.ext.join(',') : ''}`); pr(b.children, d + 1); } };
    pr(v.blocks, 0);
  }
})();
