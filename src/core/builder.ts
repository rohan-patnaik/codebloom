import type { Node, Tree, TreeCursor } from 'web-tree-sitter';
import type { Block, BlockKind, CallSite, FileGraph, ImportBinding, Lang } from './types';

/** 1-based first line of a node. */
export const lineOf = (n: Node) => n.startPosition.row + 1;
/** 1-based last line of a node (a trailing newline does not count as a line). */
export const endLineOf = (n: Node) => {
  const e = n.endPosition;
  return e.column === 0 && e.row > n.startPosition.row ? e.row : e.row + 1;
};

export const oneLine = (s: string, max = 90) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

/** "Optional[Foo]", "List<Foo>", "Foo | None", "a.b.Foo" -> "Foo" or "a.b.Foo"; null when unusable. */
export function typeName(t: string | undefined | null): string | undefined {
  if (!t) return undefined;
  let s = t.trim().replace(/^['"]|['"]$/g, '');
  const opt = /^(?:typing\.)?Optional\[(.*)\]$/.exec(s);
  if (opt) s = opt[1];
  s = s.split('|')[0].trim();
  s = s.replace(/<.*$/s, '').replace(/\[.*$/s, '').replace(/\(.*$/s, '').trim();
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(s) ? s : undefined;
}

export interface CallVisitor {
  /** Node types the visitor wants to see. */
  types: Set<string>;
  visit(node: Node, block: Block, b: GraphBuilder): void;
}

/**
 * Shared bookkeeping for the language extractors: id/qual allocation, comment
 * attachment, grouping of consecutive simple statements, and call attribution.
 */
export class GraphBuilder {
  readonly imports: ImportBinding[] = [];
  readonly top: Block[] = [];
  /** tree-sitter node id -> block whose body that node starts. */
  private owners = new Map<number, Block>();
  private quals = new Set<string>();
  pkg?: string;
  defaultExport?: string;
  summary?: string;

  constructor(
    readonly rel: string,
    readonly lang: Lang,
    readonly tree: Tree,
    readonly lineCount: number,
  ) {}

  private uniqueQual(q: string): string {
    if (!this.quals.has(q)) {
      this.quals.add(q);
      return q;
    }
    for (let i = 2; ; i++) {
      const c = `${q}#${i}`;
      if (!this.quals.has(c)) {
        this.quals.add(c);
        return c;
      }
    }
  }

  make(kind: BlockKind, name: string, parent: Block | undefined, nodes: Node[], defNode?: Node, start?: number): Block {
    const base = parent ? `${parent.qual}.${name}` : name;
    const qual = this.uniqueQual(kind === 'imports' || kind === 'globals' || kind === 'script' || kind === 'fields' || kind === 'doc' || kind === 'main' ? `${parent ? parent.qual + '.' : ''}#${kind}@${lineOf(nodes[0])}` : base);
    const blk: Block = {
      id: `${this.rel}::${qual}`,
      kind,
      name,
      qual,
      start: start ?? lineOf(nodes[0]),
      end: endLineOf(nodes[nodes.length - 1]),
      defLine: defNode ? lineOf(defNode) : lineOf(nodes[0]),
      children: [],
      calls: [],
      parent,
    };
    for (const n of nodes) this.owners.set(n.id, blk);
    (parent ? parent.children : this.top).push(blk);
    return blk;
  }

  /** Extend a group block with another statement. */
  extend(blk: Block, node: Node) {
    blk.end = Math.max(blk.end, endLineOf(node));
    this.owners.set(node.id, blk);
  }

  own(node: Node, blk: Block) {
    this.owners.set(node.id, blk);
  }

  addVar(blk: Block, name: string, type: string | undefined) {
    const t = typeName(type);
    if (!t || !name) return;
    (blk.vars ??= Object.create(null) as Record<string, string>)[name] = t;
  }

  addField(cls: Block | undefined, name: string, type: string | undefined) {
    const t = typeName(type);
    if (!cls || !t || !name) return;
    (cls.fieldTypes ??= Object.create(null) as Record<string, string>)[name] = t;
  }

  call(blk: Block, site: CallSite) {
    if (site.name) blk.calls.push(site);
  }

  /**
   * Iterate statements with their attached leading comments. A comment run
   * belongs to the next statement when nothing but line breaks separates them.
   */
  static *withComments(nodes: Node[], isComment: (n: Node) => boolean): Generator<{ node: Node; start: number }> {
    let run: Node[] = [];
    for (const n of nodes) {
      if (isComment(n)) {
        if (run.length && lineOf(n) > endLineOf(run[run.length - 1]) + 1) run = [];
        run.push(n);
        continue;
      }
      let start = lineOf(n);
      if (run.length && endLineOf(run[run.length - 1]) >= start - 1) start = lineOf(run[0]);
      run = [];
      yield { node: n, start };
    }
  }

  /** Attribute calls (and anything else the visitor wants) to the innermost owning block. */
  collect(visitor: CallVisitor) {
    const cursor: TreeCursor = this.tree.walk();
    const stack: { blk: Block; depth: number }[] = [];
    let depth = 0;
    const enter = () => {
      const id = cursor.nodeId;
      const owner = this.owners.get(id);
      if (owner) stack.push({ blk: owner, depth });
      if (stack.length && visitor.types.has(cursor.nodeType)) {
        visitor.visit(cursor.currentNode, stack[stack.length - 1].blk, this);
      }
    };
    enter();
    for (;;) {
      if (cursor.gotoFirstChild()) {
        depth++;
        enter();
        continue;
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) {
          cursor.delete();
          return;
        }
        depth--;
        while (stack.length && stack[stack.length - 1].depth > depth) stack.pop();
      }
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      enter();
    }
  }

  finish(): FileGraph {
    return {
      rel: this.rel,
      lang: this.lang,
      lineCount: this.lineCount,
      blocks: this.top,
      imports: this.imports,
      pkg: this.pkg,
      defaultExport: this.defaultExport,
      summary: this.summary,
    };
  }
}

/** Group consecutive simple statements of one kind into a single block. */
export class Grouper {
  private cur?: Block;
  private names: string[] = [];
  constructor(
    private b: GraphBuilder,
    private parent: Block | undefined,
  ) {}

  add(kind: BlockKind, node: Node, start: number, names: string[]) {
    if (this.cur && this.cur.kind === kind) {
      this.b.extend(this.cur, node);
    } else {
      this.flush();
      this.cur = this.b.make(kind, kind, this.parent, [node], undefined, start);
    }
    for (const n of names) if (n && !this.names.includes(n)) this.names.push(n);
  }

  flush() {
    if (this.cur) {
      const shown = this.names.slice(0, 6).join(', ');
      this.cur.detail = this.names.length > 6 ? `${shown}, +${this.names.length - 6}` : shown;
    }
    this.cur = undefined;
    this.names = [];
  }
}
