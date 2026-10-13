// Builds a FileGraph from the document symbols a VS Code language extension
// reports (the same data behind the Outline view). It covers every language
// without bundling a parser for each. Calls come later, on demand, from the
// language's call hierarchy.

import { oneLine } from './builder';
import type { Block, BlockKind, FileGraph } from './types';

/** The subset of vscode.DocumentSymbol used here, so this module stays testable without VS Code. */
export interface SymbolLike {
  name: string;
  detail?: string;
  kind: number;
  range: Span;
  selectionRange: Span;
  children?: SymbolLike[];
}

interface Span {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

// vscode.SymbolKind values.
const SK = {
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8,
  Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15, Boolean: 16,
  Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
};

const KIND: Record<number, [BlockKind, string?]> = {
  [SK.File]: ['namespace', 'file'],
  [SK.Module]: ['namespace', 'module'],
  [SK.Namespace]: ['namespace', 'namespace'],
  [SK.Package]: ['namespace', 'package'],
  [SK.Class]: ['class'],
  [SK.Struct]: ['class', 'struct'],
  [SK.Interface]: ['interface'],
  [SK.Enum]: ['enum'],
  [SK.Method]: ['method'],
  [SK.Constructor]: ['ctor'],
  [SK.Function]: ['function'],
  [SK.Operator]: ['function', 'operator'],
};

/** Per-language chip labels where the generic kind would mislead. */
const TAGS: Record<string, Partial<Record<number, string>>> = {
  css: { [SK.Class]: 'rule' },
  scss: { [SK.Class]: 'rule' },
  less: { [SK.Class]: 'rule' },
  markdown: { [SK.String]: 'heading' },
  html: { [SK.Field]: 'element' },
};

/** Value-like symbols (fields, variables, keys) that a function expression may hide behind. */
const FN_TEXT = /=>|\bfunction\b|\bfunc\b|\blambda\b|\bfn\b|\bdef\b|\bproc\b/;

const IMPORT_LINE = /^\s*(?:import\b|from\s+\S+\s+import\b|use\s|using\s|require\b|#\s*include\b|#import\b|@import\b|package\s|library\s|open\s|extern\s+crate\b)/;

const firstLine = (s: Span) => s.start.line + 1;
const lastLine = (s: Span) => (s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1);

/** Nest flat symbols (from providers that return SymbolInformation) by range containment. */
export function nestSymbols(flat: SymbolLike[]): SymbolLike[] {
  const sorted = [...flat].sort((a, b) => a.range.start.line - b.range.start.line || b.range.end.line - a.range.end.line);
  const roots: SymbolLike[] = [];
  const stack: SymbolLike[] = [];
  const inside = (outer: SymbolLike, s: SymbolLike) =>
    firstLine(outer.range) <= firstLine(s.range) && lastLine(s.range) <= lastLine(outer.range) && outer !== s;
  for (const s0 of sorted) {
    const s = { ...s0, children: [] as SymbolLike[] };
    while (stack.length && !inside(stack[stack.length - 1], s)) stack.pop();
    (stack.length ? stack[stack.length - 1].children! : roots).push(s);
    stack.push(s);
  }
  return roots;
}

export function symbolGraph(rel: string, lang: string, lines: string[], symbols: SymbolLike[]): FileGraph {
  const quals = new Set<string>();
  const unique = (q: string) => {
    let c = q;
    for (let i = 2; quals.has(c); i++) c = `${q}#${i}`;
    quals.add(c);
    return c;
  };
  const tags = TAGS[lang] ?? {};

  const make = (kind: BlockKind, name: string, qual: string, start: number, end: number, defLine: number, parent?: Block): Block => {
    const q = unique(qual);
    return { id: `${rel}::${q}`, kind, name, qual: q, start, end, defLine, children: [], calls: [], parent };
  };

  const isCallableKind = (k: BlockKind) => k === 'function' || k === 'method' || k === 'ctor';

  /** Kind for a symbol, or undefined when it is a plain value to group. */
  const kindOf = (s: SymbolLike): [BlockKind, string?] | undefined => {
    const k = KIND[s.kind];
    if (k) return [k[0], tags[s.kind] ?? k[1]];
    // Markdown headings are strings; every heading is a section, leaf or not.
    if (lang === 'markdown' && s.kind === SK.String) return ['section', 'heading'];
    const multi = lastLine(s.range) > firstLine(s.range);
    const head = lines[s.selectionRange.start.line] ?? '';
    if ((s.kind === SK.Variable || s.kind === SK.Constant || s.kind === SK.Property || s.kind === SK.Field) && multi && FN_TEXT.test(head)) return ['function'];
    if (s.children?.length) return ['section', /^impl\b/.test(s.name) ? 'impl' : (tags[s.kind] ?? undefined)];
    return undefined;
  };

  const signatureOf = (s: SymbolLike, kind: BlockKind) => {
    if (s.detail?.trim()) return oneLine(s.detail, 140);
    if (!isCallableKind(kind)) return undefined;
    // Fall back to whatever follows the name on its line: "(a: string): Promise<void>".
    const line = lines[s.selectionRange.start.line] ?? '';
    const at = line.indexOf(s.name, s.selectionRange.start.character);
    const after = at >= 0 ? line.slice(at + s.name.length) : '';
    if (!/^\s*[(<[]/.test(after)) return undefined;
    return oneLine(after.replace(/\s*(\{|=>|:)?\s*$/, '').replace(/\s*\{.*$/, ''), 140) || undefined;
  };

  const build = (list: SymbolLike[], parent: Block | undefined, out: Block[]) => {
    const sorted = [...list].sort((a, b) => a.range.start.line - b.range.start.line);
    const inCallable = parent && isCallableKind(parent.kind);
    let group: Block | undefined;
    let names: string[] = [];
    const flush = () => {
      if (group) {
        const shown = names.slice(0, 6).join(', ');
        group.detail = names.length > 6 ? `${shown}, +${names.length - 6}` : shown;
      }
      group = undefined;
      names = [];
    };
    for (const s of sorted) {
      const k = kindOf(s);
      const start = firstLine(s.range);
      const end = lastLine(s.range);
      if (!k) {
        // Locals inside a function are noise; elsewhere group consecutive values.
        if (inCallable) continue;
        const gk: BlockKind = parent ? 'fields' : 'globals';
        if (group) group.end = Math.max(group.end, end);
        else {
          group = make(gk, gk, `${parent ? parent.qual + '.' : ''}#${gk}@${start}`, start, end, start, parent);
          out.push(group);
        }
        if (!names.includes(s.name)) names.push(s.name);
        continue;
      }
      flush();
      const [kind, tag] = k;
      const name = s.name.trim() || '(anonymous)';
      const blk = make(kind, name, parent ? `${parent.qual}.${name}` : name, start, end, firstLine(s.selectionRange), parent);
      if (tag) blk.tag = tag;
      blk.defCol = s.selectionRange.start.character;
      blk.signature = signatureOf(s, kind);
      out.push(blk);
      if (s.children?.length) build(s.children, blk, blk.children);
    }
    flush();
  };

  const blocks: Block[] = [];
  build(symbols, undefined, blocks);

  // Imports are rarely symbols, so find them as leading lines before the first block.
  const firstStart = blocks.length ? blocks[0].start : lines.length + 1;
  let impFirst = 0;
  let impLast = 0;
  const mods: string[] = [];
  for (let i = 0; i < firstStart - 1 && i < lines.length; i++) {
    const l = lines[i];
    if (!IMPORT_LINE.test(l)) continue;
    impFirst ||= i + 1;
    impLast = i + 1;
    // Go-style grouped imports: `import (` ... `)`.
    if (/\(\s*$/.test(l)) {
      while (impLast < firstStart - 1 && impLast < lines.length && !/^\s*\)/.test(lines[impLast])) {
        const m = /["'`]([^"'`]+)["'`]/.exec(lines[impLast]);
        if (m && !mods.includes(m[1])) mods.push(m[1]);
        impLast++;
      }
      impLast = Math.min(impLast + 1, firstStart - 1);
      i = impLast - 1;
      continue;
    }
    const m = /["'`<]([^"'`>]+)["'`>]/.exec(l) ?? /^\s*(?:import|from|use|using|package|library|open)\s+([\w.:/@-]+)/.exec(l);
    if (m && !mods.includes(m[1])) mods.push(m[1]);
  }
  if (impFirst) {
    const imp = make('imports', 'imports', `#imports@${impFirst}`, impFirst, impLast, impFirst);
    const shown = mods.slice(0, 6).join(', ');
    imp.detail = mods.length > 6 ? `${shown}, +${mods.length - 6}` : shown || 'imports';
    blocks.unshift(imp);
  }

  return { rel, lang, engine: 'symbols', lineCount: lines.length, blocks, imports: [] };
}

/** Whole file as one block, for languages whose extension reports no symbols. */
export function wholeFileGraph(rel: string, lang: string, lineCount: number): FileGraph {
  const name = rel.split('/').pop() ?? rel;
  const blk: Block = { id: `${rel}::#file`, kind: 'script', name, qual: '#file', start: 1, end: Math.max(1, lineCount), defLine: 1, detail: 'whole file', children: [], calls: [] };
  return { rel, lang, engine: 'symbols', lineCount, blocks: [blk], imports: [] };
}
