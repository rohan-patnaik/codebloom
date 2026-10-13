import type { Node, Tree } from 'web-tree-sitter';
import { GraphBuilder, Grouper, lineOf, oneLine, type CallVisitor } from './builder';
import type { Block, FileGraph } from './types';

const isComment = (n: Node) => n.type === 'comment';
const FN_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const CLASS_VALUES = new Set(['class', 'class_expression']);

const unquote = (s: string) => s.replace(/^['"`]|['"`]$/g, '');

function requireSource(n: Node | null): string | undefined {
  // require('./x') or require('./x').member
  if (!n) return;
  if (n.type === 'member_expression') return requireSource(n.childForFieldName('object'));
  if (n.type === 'await_expression') return requireSource(n.namedChild(0));
  if (n.type !== 'call_expression') return;
  const fn = n.childForFieldName('function');
  if (fn?.type !== 'identifier' || fn.text !== 'require') return;
  const arg = n.childForFieldName('arguments')?.namedChild(0);
  return arg?.type === 'string' ? unquote(arg.text) : undefined;
}

function jsdocSummary(prev: Node | null): string | undefined {
  if (!prev || prev.type !== 'comment' || !prev.text.startsWith('/**')) return;
  const body = prev.text
    .replace(/^\/\*\*|\*\/$/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .filter((l) => l.trim() && !l.trim().startsWith('@'))
    .join(' ');
  return body ? oneLine(body, 80) : undefined;
}

class JsExtractor {
  constructor(private b: GraphBuilder) {}

  fn(kind: 'function' | 'method' | 'ctor', name: string, outer: Node, fnNode: Node, nameNode: Node | null, start: number, parent: Block | undefined) {
    const blk = this.b.make(kind, name, parent, [outer], nameNode ?? fnNode, start);
    const params = fnNode.childForFieldName('parameters') ?? fnNode.childForFieldName('parameter');
    blk.signature = oneLine(params ? (params.type === 'identifier' ? `(${params.text})` : params.text) : '()', 140);
    if (fnNode.type === 'arrow_function') blk.signature += ' ⇒';
    blk.detail = jsdocSummary(outer.previousNamedSibling);
    const body = fnNode.childForFieldName('body');
    if (body?.type === 'statement_block') this.nested(body, blk);
    return blk;
  }

  cls(name: string, outer: Node, clsNode: Node, start: number, parent: Block | undefined) {
    const nameNode = clsNode.childForFieldName('name');
    const blk = this.b.make('class', name, parent, [outer], nameNode ?? clsNode, start);
    blk.detail = jsdocSummary(outer.previousNamedSibling);
    const heritage = clsNode.namedChildren.find((c) => c?.type === 'class_heritage');
    const base = heritage?.namedChild(0);
    if (base && /^[\w$.]+$/.test(base.text)) {
      blk.bases = [base.text];
      blk.signature = `extends ${base.text}`;
    }
    const body = clsNode.childForFieldName('body');
    if (!body) return blk;
    const fields = new Grouper(this.b, blk);
    for (const { node, start: s } of GraphBuilder.withComments(body.namedChildren as Node[], isComment)) {
      if (node.type === 'method_definition') {
        fields.flush();
        const nameNode = node.childForFieldName('name');
        const n = nameNode?.text ?? '?';
        this.fn(n === 'constructor' ? 'ctor' : 'method', n, node, node, nameNode, s, blk);
      } else if (node.type === 'field_definition') {
        const prop = node.childForFieldName('property');
        const value = node.childForFieldName('value');
        if (value && FN_VALUES.has(value.type)) {
          fields.flush();
          this.fn('method', prop?.text ?? '?', node, value, prop, s, blk);
        } else {
          if (value?.type === 'new_expression') this.b.addField(blk, (prop?.text ?? '').replace(/^#/, ''), value.childForFieldName('constructor')?.text);
          fields.add('fields', node, s, [prop?.text ?? '']);
        }
      } else if (node.type === 'class_static_block') {
        fields.add('script', node, s, ['static { }']);
      }
    }
    fields.flush();
    return blk;
  }

  /** Named functions and classes declared directly inside a function body. */
  nested(body: Node, parent: Block) {
    for (const { node, start } of GraphBuilder.withComments(body.namedChildren as Node[], isComment)) {
      this.declaration(node, node, start, parent, undefined);
    }
  }

  /** Returns true when `node` produced a block. */
  declaration(outer: Node, node: Node, start: number, parent: Block | undefined, g: Grouper | undefined): boolean {
    const t = node.type;
    if (t === 'function_declaration' || t === 'generator_function_declaration') {
      g?.flush();
      this.fn('function', node.childForFieldName('name')?.text ?? 'default', outer, node, node.childForFieldName('name'), start, parent);
      return true;
    }
    if (t === 'class_declaration') {
      g?.flush();
      this.cls(node.childForFieldName('name')?.text ?? 'default', outer, node, start, parent);
      return true;
    }
    if (t === 'lexical_declaration' || t === 'variable_declaration') {
      const decls = node.namedChildren.filter((c) => c?.type === 'variable_declarator') as Node[];
      if (decls.length === 1) {
        const d = decls[0];
        const nameNode = d.childForFieldName('name');
        const value = d.childForFieldName('value');
        if (nameNode?.type === 'identifier' && value && FN_VALUES.has(value.type)) {
          g?.flush();
          this.fn('function', nameNode.text, outer, value, nameNode, start, parent);
          return true;
        }
        if (nameNode?.type === 'identifier' && value && CLASS_VALUES.has(value.type)) {
          g?.flush();
          this.cls(nameNode.text, outer, value, start, parent);
          return true;
        }
      }
    }
    return false;
  }

  requireBindings(node: Node): string[] | undefined {
    if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') return;
    const decls = node.namedChildren.filter((c) => c?.type === 'variable_declarator') as Node[];
    const mods: string[] = [];
    for (const d of decls) {
      const value = d.childForFieldName('value');
      const src = requireSource(value);
      if (!src) return;
      mods.push(src);
      const nameNode = d.childForFieldName('name');
      if (!nameNode) continue;
      const member = value?.type === 'member_expression' ? value.childForFieldName('property')?.text : undefined;
      if (nameNode.type === 'identifier') {
        this.b.imports.push({ local: nameNode.text, module: src, imported: member ?? '*' });
      } else if (nameNode.type === 'object_pattern') {
        for (const p of nameNode.namedChildren) {
          if (!p) continue;
          if (p.type === 'shorthand_property_identifier_pattern') this.b.imports.push({ local: p.text, module: src, imported: p.text });
          else if (p.type === 'pair_pattern') {
            const key = p.childForFieldName('key')?.text ?? '';
            const val = p.childForFieldName('value')?.text ?? key;
            this.b.imports.push({ local: val, module: src, imported: key });
          }
        }
      }
    }
    return mods;
  }

  importStatement(node: Node): string {
    const src = unquote(node.childForFieldName('source')?.text ?? '');
    const clause = node.namedChildren.find((c) => c?.type === 'import_clause');
    for (const c of clause?.namedChildren ?? []) {
      if (!c) continue;
      if (c.type === 'identifier') this.b.imports.push({ local: c.text, module: src, imported: 'default' });
      else if (c.type === 'namespace_import') this.b.imports.push({ local: c.namedChild(0)?.text ?? '', module: src, imported: '*' });
      else if (c.type === 'named_imports') {
        for (const s of c.namedChildren) {
          if (s?.type !== 'import_specifier') continue;
          const name = s.childForFieldName('name')?.text ?? '';
          this.b.imports.push({ local: s.childForFieldName('alias')?.text ?? name, module: src, imported: name });
        }
      }
    }
    return src;
  }

  /**
   * `module.exports = ...`, `exports.x = ...`, and the pre-class idioms
   * `app.handle = function () {}` / `Foo.prototype.bar = function () {}`.
   */
  exportsAssignment(node: Node, start: number, g: Grouper): boolean {
    const asg = node.namedChild(0);
    if (node.type !== 'expression_statement' || asg?.type !== 'assignment_expression') return false;
    const leftNode = asg.childForFieldName('left');
    const left = leftNode?.text ?? '';
    const right = asg.childForFieldName('right');
    if (!right || leftNode?.type !== 'member_expression' || !/^[\w$]+(\.[\w$]+)+$/.test(left)) return false;
    const m = /^(?:module\.exports|exports)(?:\.([\w$]+))?$/.exec(left);
    const name = m ? (m[1] ?? 'exports') : left;
    if (FN_VALUES.has(right.type)) {
      g.flush();
      this.fn('function', name, node, right, leftNode, start, undefined);
      if (m && !m[1]) this.b.defaultExport = name;
      return true;
    }
    if (CLASS_VALUES.has(right.type)) {
      g.flush();
      const n = right.childForFieldName('name')?.text ?? name;
      this.cls(n, node, right, start, undefined);
      if (m && !m[1]) this.b.defaultExport = n;
      return true;
    }
    if (m && !m[1] && right.type === 'identifier') this.b.defaultExport = right.text;
    return false;
  }

  program(root: Node) {
    const g = new Grouper(this.b, undefined);
    for (const { node, start } of GraphBuilder.withComments(root.namedChildren as Node[], isComment)) {
      const t = node.type;
      if (t === 'import_statement') {
        g.add('imports', node, start, [this.importStatement(node)]);
        continue;
      }
      if (t === 'export_statement') {
        const decl = node.childForFieldName('declaration');
        const isDefault = node.children.some((c) => c?.type === 'default');
        const src = node.childForFieldName('source');
        if (src) {
          // Re-export: `export { a as b } from './x'` / `export * from './x'`
          const mod = unquote(src.text);
          const clause = node.namedChildren.find((c) => c?.type === 'export_clause');
          if (clause) {
            for (const s of clause.namedChildren) {
              if (s?.type !== 'export_specifier') continue;
              const name = s.childForFieldName('name')?.text ?? '';
              this.b.imports.push({ local: s.childForFieldName('alias')?.text ?? name, module: mod, imported: name });
            }
          } else this.b.imports.push({ local: '*', module: mod, imported: '*' });
          g.add('imports', node, start, [mod]);
          continue;
        }
        if (decl && this.declaration(node, decl, start, undefined, g)) {
          if (isDefault) this.b.defaultExport = this.b.top[this.b.top.length - 1].name;
          continue;
        }
        const value = node.childForFieldName('value');
        if (isDefault && value) {
          if (value.type === 'identifier') this.b.defaultExport = value.text;
          else if (FN_VALUES.has(value.type)) {
            g.flush();
            this.fn('function', 'default', node, value, null, start, undefined);
            this.b.defaultExport = 'default';
            continue;
          } else if (CLASS_VALUES.has(value.type)) {
            g.flush();
            const n = value.childForFieldName('name')?.text ?? 'default';
            this.cls(n, node, value, start, undefined);
            this.b.defaultExport = n;
            continue;
          }
        }
        const names = decl?.type === 'lexical_declaration' || decl?.type === 'variable_declaration'
          ? (decl.namedChildren.filter((c) => c?.type === 'variable_declarator') as Node[]).map((d) => d.childForFieldName('name')?.text ?? '')
          : [oneLine(node.text.split('\n')[0], 40)];
        g.add(decl ? 'globals' : 'script', node, start, names);
        continue;
      }
      if (this.declaration(node, node, start, undefined, g)) continue;
      const mods = this.requireBindings(node);
      if (mods) {
        g.add('imports', node, start, mods);
        continue;
      }
      if (t === 'lexical_declaration' || t === 'variable_declaration') {
        const names = (node.namedChildren.filter((c) => c?.type === 'variable_declarator') as Node[]).map((d) => d.childForFieldName('name')?.text ?? '');
        g.add('globals', node, start, names);
        continue;
      }
      if (this.exportsAssignment(node, start, g)) continue;
      if (t === 'expression_statement' && node.namedChild(0)?.type === 'string' && !this.b.top.length) {
        continue; // 'use strict'
      }
      g.add('script', node, start, [oneLine(node.text.split('\n')[0], 40)]);
    }
    g.flush();
    const header = root.namedChild(0);
    if (header?.type === 'comment' && header.text.startsWith('/**')) this.b.summary = jsdocSummary(header);
  }
}

function enclosingClass(b: Block | undefined): Block | undefined {
  while (b && b.kind !== 'class') b = b.parent;
  return b;
}

const calls: CallVisitor = {
  types: new Set(['call_expression', 'new_expression', 'variable_declarator', 'assignment_expression']),
  visit(node, blk, b) {
    const t = node.type;
    const line = lineOf(node);
    if (t === 'variable_declarator' || t === 'assignment_expression') {
      const left = node.childForFieldName(t === 'variable_declarator' ? 'name' : 'left');
      let right = node.childForFieldName(t === 'variable_declarator' ? 'value' : 'right');
      if (right?.type === 'await_expression') right = right.namedChild(0);
      if (!left || right?.type !== 'new_expression') return;
      const type = right.childForFieldName('constructor')?.text;
      if (left.type === 'identifier') b.addVar(blk, left.text, type);
      else if (left.type === 'member_expression' && left.childForFieldName('object')?.type === 'this') {
        b.addField(enclosingClass(blk), left.childForFieldName('property')?.text.replace(/^#/, '') ?? '', type);
      }
      return;
    }
    if (t === 'new_expression') {
      const ctor = node.childForFieldName('constructor');
      if (ctor && /^[\w$.]+$/.test(ctor.text)) b.call(blk, { kind: 'new', name: ctor.text, line });
      return;
    }
    const fn = node.childForFieldName('function');
    if (!fn) return;
    if (fn.type === 'identifier') {
      if (fn.text !== 'require') b.call(blk, { kind: 'name', name: fn.text, line });
    } else if (fn.type === 'member_expression') {
      const obj = fn.childForFieldName('object');
      const name = fn.childForFieldName('property')?.text ?? '';
      if (!obj) return;
      if (obj.type === 'this') b.call(blk, { kind: 'self', name, line });
      else if (obj.type === 'super') b.call(blk, { kind: 'super', name, line });
      else if (obj.type === 'new_expression' && /^[\w$.]+$/.test(obj.childForFieldName('constructor')?.text ?? '')) {
        b.call(blk, { kind: 'member', name, obj: obj.childForFieldName('constructor')!.text, line });
      } else if (/^[\w$.#]+$/.test(obj.text)) b.call(blk, { kind: 'member', name, obj: obj.text, line });
      else b.call(blk, { kind: 'member', name, line });
    }
  },
};

export function extractJavaScript(tree: Tree, rel: string, lineCount: number): FileGraph {
  const b = new GraphBuilder(rel, 'javascript', tree, lineCount);
  new JsExtractor(b).program(tree.rootNode);
  b.collect(calls);
  return b.finish();
}
