import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected a stable release version, got ${version}`);
const tag = process.env.RELEASE_TAG;
if (tag && tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match package.json version ${version}`);
}
console.log(version);
