import * as vscode from 'vscode';
import { langOf, SUPPORTED_EXTENSIONS, type Engine, type Lang } from './core';

/** Language ids Codebloom parses itself, and the bundled parser for each. */
export const PARSER_IDS: Record<string, Lang> = {
  python: 'python',
  java: 'java',
  javascript: 'javascript',
  javascriptreact: 'javascript',
};

/** Languages whose outline comes with VS Code itself, so they work with nothing extra installed. */
export const BUILT_IN_IDS = ['typescript', 'typescriptreact', 'css', 'scss', 'less', 'html', 'markdown'];

export const DEFAULT_LANGUAGES = [...Object.keys(PARSER_IDS), ...BUILT_IN_IDS];

const EXT_ID: Record<string, string> = { '.py': 'python', '.java': 'java', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact' };

/** Display names for common ids; anything else is title-cased. */
const NAMES: Record<string, string> = {
  python: 'Python', java: 'Java', javascript: 'JavaScript', javascriptreact: 'JavaScript React', typescript: 'TypeScript',
  typescriptreact: 'TypeScript React', css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML', markdown: 'Markdown',
  go: 'Go', rust: 'Rust', csharp: 'C#', cpp: 'C++', c: 'C', php: 'PHP', ruby: 'Ruby', kotlin: 'Kotlin', swift: 'Swift',
  dart: 'Dart', scala: 'Scala', lua: 'Lua', r: 'R', shellscript: 'Shell', powershell: 'PowerShell', sql: 'SQL',
  json: 'JSON', jsonc: 'JSON with Comments', yaml: 'YAML', xml: 'XML', vue: 'Vue', svelte: 'Svelte', elixir: 'Elixir',
  haskell: 'Haskell', fsharp: 'F#', vb: 'Visual Basic', 'objective-c': 'Objective-C', perl: 'Perl', groovy: 'Groovy',
  julia: 'Julia', zig: 'Zig', clojure: 'Clojure', erlang: 'Erlang', ocaml: 'OCaml', solidity: 'Solidity', terraform: 'Terraform',
};

export const languageName = (id: string) => NAMES[id] ?? id.replace(/(^|[-_])(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());

const cfg = () => vscode.workspace.getConfiguration('codebloom');

export function enabledLanguages(): Set<string> {
  return new Set(cfg().get<string[]>('languages', DEFAULT_LANGUAGES));
}

export function preferLanguageServer() {
  return cfg().get<boolean>('preferLanguageServer', false);
}

/** Bundled parser languages that are switched on and not handed to the language server. */
export function parserLangs(): Lang[] {
  if (preferLanguageServer()) return [];
  const on = enabledLanguages();
  return [...new Set(Object.entries(PARSER_IDS).filter(([id]) => on.has(id)).map(([, l]) => l))];
}

/** Extensions the background index reads with the bundled parsers. */
export function indexedExtensions(): string[] {
  const on = enabledLanguages();
  if (preferLanguageServer()) return [];
  return SUPPORTED_EXTENSIONS.filter((e) => on.has(EXT_ID[e]));
}

const SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-vfs']);

/** How a document will be mapped, or undefined when Codebloom should leave it alone. */
export function engineFor(doc: Pick<vscode.TextDocument, 'uri' | 'languageId'>): Engine | undefined {
  if (!SCHEMES.has(doc.uri.scheme)) return;
  if (!enabledLanguages().has(doc.languageId)) return;
  if (PARSER_IDS[doc.languageId] && langOf(doc.uri.path) && !preferLanguageServer()) return 'parser';
  return 'symbols';
}

/** Turn a language on (or off) in the user's settings. */
export async function setLanguageEnabled(id: string, on: boolean) {
  const list = new Set(enabledLanguages());
  if (on) list.add(id);
  else list.delete(id);
  await cfg().update('languages', [...list], vscode.ConfigurationTarget.Global);
}

/** Command: pick which languages Codebloom maps. */
export async function chooseLanguages() {
  const on = enabledLanguages();
  const all = new Set([...(await vscode.languages.getLanguages()), ...on]);
  const describe = (id: string) =>
    PARSER_IDS[id] ? 'built-in parser, links across files' : BUILT_IN_IDS.includes(id) ? 'outline from VS Code, works out of the box' : 'needs a language extension with Outline support';
  const ids = [...all].filter((id) => !['plaintext', 'log', 'Log', 'code-text-binary', 'search-result', 'snippets', 'ignore', 'properties'].includes(id));
  const rank = (id: string) => (PARSER_IDS[id] ? 0 : BUILT_IN_IDS.includes(id) ? 1 : 2);
  ids.sort((a, b) => Number(on.has(b)) - Number(on.has(a)) || rank(a) - rank(b) || languageName(a).localeCompare(languageName(b)));
  const items = ids.map((id) => ({ label: languageName(id), description: id, detail: describe(id), picked: on.has(id), id }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Codebloom: languages to map',
    placeHolder: 'Ticked languages get a mind map. Others are left alone.',
    matchOnDescription: true,
  });
  if (!picked) return;
  await cfg().update('languages', picked.map((p) => p.id), vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(`$(check) Codebloom maps ${picked.length} language${picked.length === 1 ? '' : 's'}`, 3000);
}
