import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';

const [store, directory = 'release-packages'] = process.argv.slice(2);
if (!['vscode', 'open-vsx', 'jetbrains'].includes(store)) throw new Error('Choose vscode, open-vsx or jetbrains');
const { version, publisher, name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const token = process.env.PUBLISH_TOKEN;
const headers = store === 'jetbrains' && token ? { Authorization: `Bearer ${token}` } : {};

async function json(url, options = {}, allowMissing = false) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60_000) });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`${store}: request failed with HTTP ${response.status}`);
  return response.json();
}

function report(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

let exists;
if (store === 'vscode') {
  const result = await json('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.2-preview.1' },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: `${publisher}.${name}` }] }], flags: 1 }),
  });
  exists = result.results[0].extensions.some(extension => extension.versions.some(v => v.version === version));
} else if (store === 'open-vsx') {
  exists = (await json(`https://open-vsx.org/api/${publisher}/${name}/${version}`, {}, true))?.version === version;
} else {
  const updates = await json('https://plugins.jetbrains.com/api/plugins/35075/updates?size=100', { headers });
  exists = updates.some(update => update.version === version);
}

if (exists) {
  report(`${store}: ${version} is already present; no upload needed.`);
} else {
  if (store !== 'open-vsx' && !token) throw new Error(`${store}: missing publishing credential. Configure the matching GitHub Actions secret.`);
  if (store === 'jetbrains') {
    const file = join(directory, `codebloom-intellij-${version}.zip`);
    const form = new FormData();
    form.set('xmlId', 'io.github.rohanpatnaik.codebloom');
    form.set('file', new Blob([readFileSync(file)], { type: 'application/zip' }), basename(file));
    await json('https://plugins.jetbrains.com/api/updates/upload', {
      method: 'POST', headers, body: form,
    });
    report(`JetBrains: ${version} submitted. Public availability still requires JetBrains approval.`);
  } else {
    const file = join(directory, `codebloom-${version}.vsix`);
    const command = store === 'vscode'
      ? ['--no-install', 'vsce', 'publish', '--packagePath', file]
      : ['--yes', 'ovsx@1.2.0', 'publish', file, '--trusted-publishing'];
    const credential = store === 'vscode' ? { VSCE_PAT: token } : {};
    const result = spawnSync('npx', command, {
      stdio: 'inherit', env: { ...process.env, ...credential },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${store}: publisher exited with status ${result.status}`);
    report(`${store}: ${version} upload completed.`);
  }
}
