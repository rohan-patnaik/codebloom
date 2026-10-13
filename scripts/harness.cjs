// Dev only: render the webview in a plain browser with a real model.
// Usage: node scripts/harness.cjs <root-dir> <rel-file> [light]
const fs = require('fs'), path = require('path');
const { Parsers, Project, langOf } = require('../dist-test/core.js');
(async () => {
  const [root, rel, theme] = process.argv.slice(2);
  const parsers = await Parsers.create(path.join(__dirname, '..', 'dist'));
  const project = new Project();
  (function rec(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git', 'venv', '.venv', '__pycache__'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) rec(p); else if (langOf(p)) { const g = parsers.parse(path.relative(root, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf8')); if (g) project.set(g); } } })(root);
  const model = project.view(rel);
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const light = theme === 'light';
  const vars = light
    ? '--vscode-editor-background:#ffffff;--vscode-editor-foreground:#1f2328;--vscode-font-family:-apple-system,BlinkMacSystemFont,sans-serif;--vscode-editor-font-family:Menlo,monospace;--vscode-button-background:#6a55c4;--vscode-button-foreground:#fff;'
    : '--vscode-editor-background:#1e1e24;--vscode-editor-foreground:#d4d4dc;--vscode-font-family:-apple-system,BlinkMacSystemFont,sans-serif;--vscode-editor-font-family:Menlo,monospace;--vscode-button-background:#b8a9f0;--vscode-button-foreground:#1e1e24;';
  const html = `<!DOCTYPE html><html style="${vars}"><head><meta charset="utf-8"><link rel="stylesheet" href="../dist/webview.css"></head>
<body class="${light ? 'vscode-light' : 'vscode-dark'}"><div id="app"></div>
<script>
window.__log=[];
function acquireVsCodeApi(){return{postMessage(m){window.__log.push(m); if(m.type==='ready') setTimeout(()=>window.postMessage(${JSON.stringify({ type: 'model', model, uri: 'file:///' + rel, text, language: { id: model.lang, name: { python: 'Python', java: 'Java', javascript: 'JavaScript' }[model.lang] ?? model.lang, builtIn: true }, config: { mode: 'names', maxCardLines: 24, indexWorkspace: true } }).replace(/<\//g, '<\\/')},'*'),0);},getState(){return null},setState(){}}}
</script>
<script src="../dist/webview.js"></script></body></html>`;
  fs.mkdirSync(path.join(__dirname, '..', 'harness'), { recursive: true });
  const out = path.join(__dirname, '..', 'harness', (light ? 'light-' : '') + 'index.html');
  fs.writeFileSync(out, html);
  console.log(out);
})();
