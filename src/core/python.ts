import type { Node, Tree } from 'web-tree-sitter';
import { GraphBuilder, Grouper, lineOf, oneLine, type CallVisitor } from './builder';
import type { Block, FileGraph } from './types';

const isComment = (n: Node) => n.type === 'comment';

function isDocstring(n: Node) {
  return n.type === 'expression_statement' && n.namedChildCount === 1 && n.namedChild(0)!.type === 'string';
}

function docText(n: Node) {
  return oneLine(n.text.replace(/^[rubfRUBF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, ''), 80);
}

function assignTargets(n: Node): string[] {
  const out: string[] = [];
  for (const c of n.namedChildren) {
    if (!c) continue;
    if (c.type === 'assignment' || c.type === 'augmented_assignment') {
      const left = c.childForFieldName('left');
      if (left) out.push(...left.text.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (c.type === 'type_alias_statement') {
      out.push(c.namedChild(0)?.text ?? '');
    }
  }
  return out;
}

function isAssignment(n: Node) {
  return (
    (n.type === 'expression_statement' &&
      n.namedChildren.some((c) => c && (c.type === 'assignment' || c.type === 'augmented_assignment'))) ||
    n.type === 'type_alias_statement'
  );
}

function isMainGuard(n: Node) {
  if (n.type !== 'if_statement') return false;
  const cond = n.childForFieldName('condition')?.text ?? '';
  return cond.includes('__name__') && cond.includes('__main__');
}

function importNames(n: Node): string[] {
  if (n.type === 'import_from_statement') {
    const mod = n.childForFieldName('module_name')?.text ?? '';
    return [mod];
  }
  return n.namedChildren.filter((c) => c && c.type !== 'comment').map((c) => (c!.type === 'aliased_import' ? c!.childForFieldName('name')!.text : c!.text));
}

function addImports(b: GraphBuilder, n: Node) {
  if (n.type === 'import_statement') {
    for (const c of n.namedChildren) {
      if (!c) continue;
      if (c.type === 'aliased_import') {
        const mod = c.childForFieldName('name')!.text;
        b.imports.push({ local: c.childForFieldName('alias')!.text, module: mod, imported: '*' });
      } else if (c.type === 'dotted_name') {
        // `import a.b.c` binds `a`, but calls are written as `a.b.c.f()`; keep the full path.
        b.imports.push({ local: c.text, module: c.text, imported: '*' });
        const head = c.text.split('.')[0];
        if (head !== c.text) b.imports.push({ local: head, module: head, imported: '*' });
      }
    }
    return;
  }
  if (n.type !== 'import_from_statement') return;
  const modNode = n.childForFieldName('module_name');
  let module = modNode?.text ?? '';
  let level = 0;
  if (modNode?.type === 'relative_import') {
    const m = /^(\.+)(.*)$/.exec(module)!;
    level = m[1].length;
    module = m[2];
  }
  let any = false;
  for (const c of n.childrenForFieldName('name')) {
    if (!c) continue;
    any = true;
    if (c.type === 'aliased_import') {
      b.imports.push({ local: c.childForFieldName('alias')!.text, module, imported: c.childForFieldName('name')!.text, level });
    } else {
      b.imports.push({ local: c.text, module, imported: c.text, level });
    }
  }
  if (!any && n.namedChildren.some((c) => c?.type === 'wildcard_import')) {
    b.imports.push({ local: '*', module, imported: '*', level });
  }
}

function signature(fn: Node) {
  const params = fn.childForFieldName('parameters')?.text ?? '()';
  const ret = fn.childForFieldName('return_type')?.text;
  return oneLine(ret ? `${params} → ${ret}` : params, 140);
}

class PyExtractor {
  constructor(private b: GraphBuilder) {}

  def(node: Node, start: number, parent: Block | undefined, inClass: boolean): Block | undefined {
    const def = node.type === 'decorated_definition' ? node.childForFieldName('definition') : node;
    if (!def) return;
    const name = def.childForFieldName('name')?.text ?? '?';
    const decorators = node.type === 'decorated_definition' ? node.namedChildren.filter((c) => c?.type === 'decorator').map((c) => oneLine(c!.text, 60)) : [];
    if (def.type === 'class_definition') {
      const blk = this.b.make('class', name, parent, [node], def, start);
      if (decorators.length) blk.decorators = decorators;
      const sup = def.childForFieldName('superclasses');
      if (sup) {
        blk.bases = sup.namedChildren
          .filter((c) => c && (c.type === 'identifier' || c.type === 'attribute'))
          .map((c) => c!.text);
        if (blk.bases.length) blk.signature = `(${blk.bases.join(', ')})`;
      }
      this.body(def.childForFieldName('body'), blk, true);
      return blk;
    }
    if (def.type === 'function_definition') {
      const kind = inClass ? (name === '__init__' ? 'ctor' : 'method') : 'function';
      const blk = this.b.make(kind, name, parent, [node], def, start);
      blk.signature = signature(def);
      if (decorators.length) blk.decorators = decorators;
      const params = def.childForFieldName('parameters');
      for (const p of params?.namedChildren ?? []) {
        if (p && (p.type === 'typed_parameter' || p.type === 'typed_default_parameter')) {
          const pn = p.type === 'typed_parameter' ? p.namedChild(0)?.text : p.childForFieldName('name')?.text;
          this.b.addVar(blk, pn ?? '', p.childForFieldName('type')?.text);
        }
      }
      this.body(def.childForFieldName('body'), blk, false);
      return blk;
    }
  }

  /** Nested definitions inside a class or function body. */
  body(body: Node | null, parent: Block, inClass: boolean) {
    if (!body) return;
    const fields = new Grouper(this.b, parent);
    for (const { node, start } of GraphBuilder.withComments(body.namedChildren as Node[], isComment)) {
      if (node.type === 'function_definition' || node.type === 'class_definition' || node.type === 'decorated_definition') {
        fields.flush();
        this.def(node, start, parent, inClass);
      } else if (inClass && isAssignment(node)) {
        fields.add('fields', node, start, assignTargets(node));
      } else if (inClass && isDocstring(node) && !parent.detail) {
        parent.detail = docText(node);
      }
    }
    fields.flush();
  }

  module(root: Node) {
    const g = new Grouper(this.b, undefined);
    let first = true;
    for (const { node, start } of GraphBuilder.withComments(root.namedChildren as Node[], isComment)) {
      const t = node.type;
      if (first && isDocstring(node)) {
        g.flush();
        const blk = this.b.make('doc', 'doc', undefined, [node], undefined, start);
        blk.detail = docText(node);
        this.b.summary = blk.detail;
      } else if (t === 'import_statement' || t === 'import_from_statement' || t === 'future_import_statement') {
        addImports(this.b, node);
        g.add('imports', node, start, importNames(node));
      } else if (t === 'function_definition' || t === 'class_definition' || t === 'decorated_definition') {
        g.flush();
        this.def(node, start, undefined, false);
      } else if (isMainGuard(node)) {
        g.flush();
        const blk = this.b.make('main', '__main__', undefined, [node], undefined, start);
        blk.detail = 'if __name__ == "__main__"';
        // Imports inside the guard still count.
        for (const c of node.childForFieldName('consequence')?.namedChildren ?? []) {
          if (c && (c.type === 'import_statement' || c.type === 'import_from_statement')) addImports(this.b, c);
        }
      } else if (isAssignment(node)) {
        g.add('globals', node, start, assignTargets(node));
      } else {
        g.add('script', node, start, [oneLine(node.text.split('\n')[0], 40)]);
        if (t === 'try_statement' || t === 'if_statement') {
          // Imports guarded by try/except ImportError are still imports.
          const walk = (n: Node) => {
            for (const c of n.namedChildren) {
              if (!c) continue;
              if (c.type === 'import_statement' || c.type === 'import_from_statement') addImports(this.b, c);
              else if (c.type === 'block' || c.type === 'except_clause' || c.type === 'else_clause' || c.type === 'finally_clause') walk(c);
            }
          };
          walk(node);
        }
      }
      first = false;
    }
    g.flush();
  }
}

function enclosingClass(b: Block | undefined): Block | undefined {
  while (b && b.kind !== 'class') b = b.parent;
  return b;
}

/** Record a function passed as a value: `graph.add_node("plan", plan_node)`, `{"a": handler}`. */
function ref(n: Node | null, blk: Block, b: GraphBuilder) {
  if (n?.type === 'keyword_argument') n = n.childForFieldName('value');
  if (!n) return;
  const line = lineOf(n);
  if (n.type === 'identifier') {
    if (n.text !== 'self' && n.text !== 'cls') b.call(blk, { kind: 'name', name: n.text, line, ref: true });
  } else if (n.type === 'attribute') {
    const obj = n.childForFieldName('object');
    const name = n.childForFieldName('attribute')?.text ?? '';
    if (obj?.type === 'identifier' && (obj.text === 'self' || obj.text === 'cls')) b.call(blk, { kind: 'self', name, line, ref: true });
    else if (obj && /^[\w.]+$/.test(obj.text)) b.call(blk, { kind: 'member', name, obj: obj.text, line, ref: true });
  }
}

const calls: CallVisitor = {
  types: new Set(['call', 'assignment', 'dictionary', 'list', 'set']),
  visit(node, blk, b) {
    if (node.type === 'dictionary') {
      for (const p of node.namedChildren) if (p?.type === 'pair') ref(p.childForFieldName('value'), blk, b);
      return;
    }
    if (node.type === 'list' || node.type === 'set') {
      for (const c of node.namedChildren) ref(c, blk, b);
      return;
    }
    if (node.type === 'assignment') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      const annot = node.childForFieldName('type')?.text;
      let type = annot;
      if (right?.type === 'call') {
        const fn = right.childForFieldName('function');
        if (fn && (fn.type === 'identifier' || fn.type === 'attribute')) type = fn.text;
      }
      if (!left || !type) return;
      if (left.type === 'identifier') b.addVar(blk, left.text, type);
      else if (left.type === 'attribute' && /^self\.\w+$/.test(left.text)) b.addField(enclosingClass(blk), left.text.slice(5), type);
      return;
    }
    const fn = node.childForFieldName('function');
    if (!fn) return;
    const args = node.childForFieldName('arguments');
    if (args?.type === 'argument_list') for (const a of args.namedChildren) ref(a, blk, b);
    const line = lineOf(node);
    if (fn.type === 'identifier') {
      if (fn.text !== 'super') b.call(blk, { kind: 'name', name: fn.text, line });
    } else if (fn.type === 'attribute') {
      const obj = fn.childForFieldName('object');
      const name = fn.childForFieldName('attribute')?.text ?? '';
      if (!obj) return;
      if (obj.type === 'identifier' && (obj.text === 'self' || obj.text === 'cls')) {
        b.call(blk, { kind: 'self', name, line });
      } else if (obj.type === 'call' && obj.childForFieldName('function')?.text === 'super') {
        b.call(blk, { kind: 'super', name, line });
      } else if (/^[\w.]+$/.test(obj.text)) {
        b.call(blk, { kind: 'member', name, obj: obj.text, line });
      } else {
        b.call(blk, { kind: 'member', name, line });
      }
    }
  },
};

export function extractPython(tree: Tree, rel: string, lineCount: number): FileGraph {
  const b = new GraphBuilder(rel, 'python', tree, lineCount);
  new PyExtractor(b).module(tree.rootNode);
  b.collect(calls);
  return b.finish();
}
