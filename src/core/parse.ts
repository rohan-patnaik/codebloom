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

/** File extensions handled by one bundled parser language. */
export const extensionsOf = (lang: Lang) => SUPPORTED_EXTENSIONS.filter((e) => EXT[e] === lang);

const GRAMMARS: Record<Lang, string> = {
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
  javascript: 'tree-sitter-javascript.wasm',
};

const countLines = (s: string) => {
  let n = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return s.endsWith('\n') ? n - 1 : n;
};

/**
 * One tree-sitter parser per language, loaded from the bundled WASM grammars.
 * Grammars load on first use, so a Python-only workspace never pays for Java.
 */
export class Parsers {
  private parsers = new Map<Lang, Parser>();
  private loading = new Map<Lang, Promise<void>>();

  private constructor(private wasmDir: string) {}

  /** Start the tree-sitter runtime and load `preload` grammars (all of them by default). */
  static async create(wasmDir: string, preload: Lang[] = ['python', 'java', 'javascript']): Promise<Parsers> {
    await Parser.init({ locateFile: (name: string) => path.join(wasmDir, name) });
    const p = new Parsers(wasmDir);
    await Promise.all(preload.map((l) => p.load(l)));
    return p;
  }

  load(lang: Lang): Promise<void> {
    let pending = this.loading.get(lang);
    if (!pending) {
      pending = Language.load(path.join(this.wasmDir, GRAMMARS[lang])).then((language) => {
        const p = new Parser();
        p.setLanguage(language);
        this.parsers.set(lang, p);
      });
      this.loading.set(lang, pending);
    }
    return pending;
  }

  loaded(lang: Lang) {
    return this.parsers.has(lang);
  }

  /** Parse with a grammar that is already loaded. Use `parseAsync` when it may not be. */
  parse(rel: string, text: string, lang = langOf(rel)): FileGraph | undefined {
    if (!lang) return;
    const parser = this.parsers.get(lang);
    if (!parser) throw new Error(`Codebloom: the ${lang} grammar is not loaded`);
    const tree = parser.parse(text);
    if (!tree) return;
    try {
      const lines = countLines(text);
      const graph = lang === 'python' ? extractPython(tree, rel, lines) : lang === 'java' ? extractJava(tree, rel, lines) : extractJavaScript(tree, rel, lines);
      graph.engine = 'parser';
      return graph;
    } finally {
      tree.delete();
    }
  }

  async parseAsync(rel: string, text: string, lang = langOf(rel)): Promise<FileGraph | undefined> {
    if (!lang) return;
    await this.load(lang);
    return this.parse(rel, text, lang);
  }
}
