import type { Node, Tree } from 'web-tree-sitter';
import { GraphBuilder, Grouper, lineOf, oneLine, type CallVisitor } from './builder';
import type { Block, BlockKind, FileGraph } from './types';

const isComment = (n: Node) => n.type === 'line_comment' || n.type === 'block_comment';

const CLASS_LIKE: Record<string, BlockKind> = {
  class_declaration: 'class',
  record_declaration: 'class',
  interface_declaration: 'interface',
  annotation_type_declaration: 'interface',
  enum_declaration: 'enum',
};

const stripGenerics = (s: string) => s.replace(/<.*$/s, '').trim();

function declaratorNames(n: Node): string[] {
  return n.childrenForFieldName('declarator').map((d) => d?.childForFieldName('name')?.text ?? '');
}

function javadocSummary(comment: Node | null): string | undefined {
  if (!comment || comment.type !== 'block_comment' || !comment.text.startsWith('/**')) return;
  const body = comment.text
    .replace(/^\/\*\*|\*\/$/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .filter((l) => l.trim() && !l.trim().startsWith('@'))
    .join(' ');
  return body ? oneLine(body, 80) : undefined;
}

class JavaExtractor {
  constructor(private b: GraphBuilder) {}

  classLike(node: Node, start: number, parent: Block | undefined) {
    const kind = CLASS_LIKE[node.type];
    const name = node.childForFieldName('name')?.text ?? '?';
    const nameNode = node.childForFieldName('name') ?? node;
    const blk = this.b.make(kind, name, parent, [node], nameNode, start);
    blk.detail = javadocSummary(node.previousNamedSibling);
    const bases: string[] = [];
    const sup = node.childForFieldName('superclass');
    if (sup?.namedChild(0)) bases.push(stripGenerics(sup.namedChild(0)!.text));
    const ifaces = node.childForFieldName('interfaces') ?? node.namedChildren.find((c) => c?.type === 'extends_interfaces');
    for (const t of ifaces?.namedChild(0)?.namedChildren ?? []) if (t) bases.push(stripGenerics(t.text));
    if (bases.length) {
      blk.bases = bases;
      blk.signature = `extends ${bases.join(', ')}`;
    }
    if (node.type === 'record_declaration') {
      const params = node.childForFieldName('parameters');
      blk.signature = oneLine((params?.text ?? '()') + (blk.signature ? ' ' + blk.signature : ''), 140);
      for (const p of params?.namedChildren ?? []) {
        if (p?.type === 'formal_parameter') this.b.addField(blk, p.childForFieldName('name')?.text ?? '', stripGenerics(p.childForFieldName('type')?.text ?? ''));
      }
    }
    const body = node.childForFieldName('body');
    if (body) this.members(body, blk);
    return blk;
  }

  members(body: Node, cls: Block) {
    let items = body.namedChildren as Node[];
    if (body.type === 'enum_body') {
      // Constants come first and group into one block; members follow.
      const decls = items.find((c) => c.type === 'enum_body_declarations');
      items = [...items.filter((c) => c.type !== 'enum_body_declarations'), ...((decls?.namedChildren as Node[]) ?? [])];
    }
    const g = new Grouper(this.b, cls);
    for (const { node, start } of GraphBuilder.withComments(items, isComment)) {
      const t = node.type;
      if (CLASS_LIKE[t]) {
        g.flush();
        this.classLike(node, start, cls);
      } else if (t === 'method_declaration' || t === 'constructor_declaration' || t === 'compact_constructor_declaration') {
        g.flush();
        const nameNode = node.childForFieldName('name')!;
        const isCtor = t !== 'method_declaration';
        const blk = this.b.make(isCtor ? 'ctor' : 'method', nameNode.text, cls, [node], nameNode, start);
        const params = node.childForFieldName('parameters');
        const ret = node.childForFieldName('type')?.text;
        blk.signature = oneLine((params?.text ?? '()') + (ret ? ` → ${ret}` : ''), 140);
        blk.detail = javadocSummary(node.previousNamedSibling);
        const ps = (params?.namedChildren ?? []).filter((p) => p?.type === 'formal_parameter' || p?.type === 'spread_parameter');
        const varargs = ps.some((p) => p?.type === 'spread_parameter');
        blk.arity = [varargs ? ps.length - 1 : ps.length, varargs ? Infinity : ps.length];
        for (const p of params?.namedChildren ?? []) {
          if (p?.type === 'formal_parameter' || p?.type === 'spread_parameter') {
            this.b.addVar(blk, p.childForFieldName('name')?.text ?? '', stripGenerics(p.childForFieldName('type')?.text ?? ''));
          }
        }
      } else if (t === 'field_declaration' || t === 'constant_declaration') {
        const type = stripGenerics(node.childForFieldName('type')?.text ?? '');
        const names = declaratorNames(node);
        for (const n of names) this.b.addField(cls, n, type);
        g.add('fields', node, start, names);
      } else if (t === 'enum_constant') {
        g.add('fields', node, start, [node.childForFieldName('name')?.text ?? '']);
      } else if (t === 'static_initializer' || t === 'block') {
        g.add('script', node, start, [t === 'static_initializer' ? 'static { }' : '{ }']);
      }
    }
    g.flush();
  }

  program(root: Node) {
    const g = new Grouper(this.b, undefined);
    for (const { node, start } of GraphBuilder.withComments(root.namedChildren as Node[], isComment)) {
      const t = node.type;
      if (t === 'package_declaration') {
        this.b.pkg = node.namedChild(0)?.text;
        g.add('imports', node, start, [`package ${this.b.pkg}`]);
      } else if (t === 'import_declaration') {
        const isStatic = node.children.some((c) => c?.type === 'static');
        const path = node.namedChildren.find((c) => c?.type === 'scoped_identifier' || c?.type === 'identifier')?.text ?? '';
        const star = node.namedChildren.some((c) => c?.type === 'asterisk');
        if (star) {
          this.b.imports.push({ local: '*', module: path, imported: '*', isStatic });
        } else {
          const i = path.lastIndexOf('.');
          this.b.imports.push({ local: path.slice(i + 1), module: path.slice(0, i), imported: path.slice(i + 1), isStatic });
        }
        g.add('imports', node, start, [path + (star ? '.*' : '')]);
      } else if (CLASS_LIKE[t]) {
        g.flush();
        this.classLike(node, start, undefined);
      }
    }
    g.flush();
    const first = this.b.top.find((x) => x.kind !== 'imports');
    if (first?.detail) this.b.summary = first.detail;
  }
}

const calls: CallVisitor = {
  types: new Set(['method_invocation', 'object_creation_expression', 'method_reference', 'local_variable_declaration', 'enhanced_for_statement', 'catch_formal_parameter']),
  visit(node, blk, b) {
    const t = node.type;
    const line = lineOf(node);
    const args = node.childForFieldName('arguments');
    const argc = args ? args.namedChildren.filter((c) => c && c.type !== 'line_comment' && c.type !== 'block_comment').length : undefined;
    if (t === 'local_variable_declaration') {
      const declared = stripGenerics(node.childForFieldName('type')?.text ?? '');
      for (const d of node.childrenForFieldName('declarator')) {
        if (!d) continue;
        let type = declared;
        const val = d.childForFieldName('value');
        if (declared === 'var' && val?.type === 'object_creation_expression') type = stripGenerics(val.childForFieldName('type')?.text ?? '');
        if (type !== 'var') b.addVar(blk, d.childForFieldName('name')?.text ?? '', type);
      }
      return;
    }
    if (t === 'enhanced_for_statement') {
      b.addVar(blk, node.childForFieldName('name')?.text ?? '', stripGenerics(node.childForFieldName('type')?.text ?? ''));
      return;
    }
    if (t === 'catch_formal_parameter') return;
    if (t === 'object_creation_expression') {
      const type = stripGenerics(node.childForFieldName('type')?.text ?? '');
      if (type) b.call(blk, { kind: 'new', name: type, line, argc });
      return;
    }
    if (t === 'method_reference') {
      const parts = node.namedChildren.filter(Boolean) as Node[];
      if (parts.length < 2) return;
      const obj = parts[0];
      const name = parts[parts.length - 1].text;
      if (obj.type === 'this') b.call(blk, { kind: 'self', name, line });
      else if (name === 'new') b.call(blk, { kind: 'new', name: stripGenerics(obj.text), line });
      else b.call(blk, { kind: 'member', name, obj: obj.text, line });
      return;
    }
    const name = node.childForFieldName('name')?.text ?? '';
    const obj = node.childForFieldName('object');
    if (!obj) b.call(blk, { kind: 'name', name, line, argc });
    else if (obj.type === 'this') b.call(blk, { kind: 'self', name, line, argc });
    else if (obj.type === 'super') b.call(blk, { kind: 'super', name, line, argc });
    else if (obj.type === 'object_creation_expression') b.call(blk, { kind: 'member', name, obj: stripGenerics(obj.childForFieldName('type')?.text ?? ''), line, argc });
    else if (/^[\w$.]+$/.test(obj.text)) b.call(blk, { kind: 'member', name, obj: obj.text, line, argc });
    else b.call(blk, { kind: 'member', name, line, argc });
  },
};

export function extractJava(tree: Tree, rel: string, lineCount: number): FileGraph {
  const b = new GraphBuilder(rel, 'java', tree, lineCount);
  new JavaExtractor(b).program(tree.rootNode);
  b.collect(calls);
  return b.finish();
}
