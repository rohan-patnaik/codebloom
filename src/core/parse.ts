import * as path from 'path';
import { Language, Parser } from 'web-tree-sitter';
import { extractJava } from './java';
import { extractJavaScript } from './javascript';
import { extractPython } from './python';
import type { FileGraph, Lang } from './types';

const EXT: Record<string, Lang> = {
  '.py': 'python',
  '.java': 'java',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXT);

export function langOf(file: string): Lang | undefined {
  return EXT[path.extname(file).toLowerCase()];
}

const countLines = (s: string) => {
  let n = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return s.endsWith('\n') ? n - 1 : n;
};

/** One tree-sitter parser per language, loaded from the bundled WASM grammars. */
export class Parsers {
  private constructor(private parsers: Map<Lang, Parser>) {}

  static async create(wasmDir: string): Promise<Parsers> {
    await Parser.init({ locateFile: (name: string) => path.join(wasmDir, name) });
    const langs: [Lang, string][] = [
      ['python', 'tree-sitter-python.wasm'],
      ['java', 'tree-sitter-java.wasm'],
      ['javascript', 'tree-sitter-javascript.wasm'],
    ];
    const map = new Map<Lang, Parser>();
    await Promise.all(
      langs.map(async ([lang, file]) => {
        const p = new Parser();
        p.setLanguage(await Language.load(path.join(wasmDir, file)));
        map.set(lang, p);
      }),
    );
    return new Parsers(map);
  }

  parse(rel: string, text: string, lang = langOf(rel)): FileGraph | undefined {
    if (!lang) return;
    const parser = this.parsers.get(lang)!;
    const tree = parser.parse(text);
    if (!tree) return;
    try {
      const lines = countLines(text);
      if (lang === 'python') return extractPython(tree, rel, lines);
      if (lang === 'java') return extractJava(tree, rel, lines);
      return extractJavaScript(tree, rel, lines);
    } finally {
      tree.delete();
    }
  }
}
