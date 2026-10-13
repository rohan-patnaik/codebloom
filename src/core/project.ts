import * as path from 'path';
import { isCallable, isContainer, walk, type Block, type CallSite, type FileGraph, type ImportBinding } from './types';

/** What a name can resolve to: a block in some file, or a whole module (file). */
type Target = { block: Block; file: FileIndex } | { module: FileIndex };

interface FileIndex {
  graph: FileGraph;
  rel: string;
  /** Top-level named blocks (classes, functions). */
  top: Map<string, Block>;
  /** Variables assigned at module level: name -> type. */
  moduleVars: Record<string, string>;
}

export interface Link {
  id: string;
  /** Line of the call site. */
  at: number;
}

export interface Ref {
  id: string;
  label: string;
  rel: string;
  line: number;
  kind: string;
  /** Line of the call site, in the calling file. */
  at: number;
  /** Set for language-server results, which may point at files outside the index. */
  uri?: string;
}

export interface ViewBlock {
  id: string;
  kind: string;
  name: string;
  qual: string;
  start: number;
  end: number;
  defLine: number;
  signature?: string;
  detail?: string;
  tag?: string;
  decorators?: string[];
  children: ViewBlock[];
}

export interface ViewLinks {
  out: Ref[];
  in: Ref[];
  ext: string[];
  /** Blocks that pass this one around as a value (callbacks, handlers, graph nodes). */
  refs: Ref[];
}

export interface ViewModel {
  rel: string;
  lang: string;
  engine: 'parser' | 'symbols';
  lineCount: number;
  summary?: string;
  blocks: ViewBlock[];
  links: Record<string, ViewLinks>;
  stats: { files: number; lines: number; links: number; indexing: boolean; truncated?: number };
}

const JS_EXTS = ['', '.js', '.mjs', '.cjs', '.jsx', '/index.js', '/index.mjs', '/index.jsx'];
const MAX_DEPTH = 6;

function ctorOf(cls: Block): Block[] {
  const ctors = cls.children.filter((c) => c.kind === 'ctor');
  return ctors.length ? ctors : [cls];
}

function commonPrefix(a: string, b: string) {
  const pa = a.split('/');
  const pb = b.split('/');
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
  return i;
}

/**
 * Holds every indexed file and resolves call sites to blocks, statically and
 * best-effort. Resolution is recomputed lazily after any file changes.
 */
export class Project {
  private files = new Map<string, FileIndex>();
  private dirty = true;
  // Derived indexes, rebuilt when dirty.
  private pyModules = new Map<string, FileIndex[]>();
  private javaTypes = new Map<string, { block: Block; file: FileIndex }>();
  private javaPackages = new Map<string, FileIndex[]>();
  private blockFile = new Map<string, FileIndex>();
  private blocks = new Map<string, Block>();
  private out = new Map<string, Link[]>();
  private in = new Map<string, Link[]>();
  private ext = new Map<string, string[]>();
  private refIn = new Map<string, Link[]>();
  private nameCache = new Map<string, Target[]>();
  private linkCount = 0;
  indexing = false;
  /** Set to the file limit when the workspace index stopped early. */
  truncated?: number;

  get fileCount() {
    return this.files.size;
  }

  has(rel: string) {
    return this.files.has(rel);
  }

  graph(rel: string) {
    return this.files.get(rel)?.graph;
  }

  set(graph: FileGraph) {
    const top = new Map<string, Block>();
    const moduleVars: Record<string, string> = Object.create(null);
    for (const b of graph.blocks) {
      if (isContainer(b) || isCallable(b)) {
        if (!top.has(b.name)) top.set(b.name, b);
      } else if (b.vars) Object.assign(moduleVars, b.vars);
    }
    this.files.set(graph.rel, { graph, rel: graph.rel, top, moduleVars });
    this.dirty = true;
  }

  delete(rel: string) {
    if (this.files.delete(rel)) this.dirty = true;
  }

  clear() {
    this.files.clear();
    this.dirty = true;
  }

  // ---------------------------------------------------------------- indexes

  private rebuild() {
    this.pyModules.clear();
    this.javaTypes.clear();
    this.javaPackages.clear();
    this.blockFile.clear();
    this.blocks.clear();
    this.nameCache.clear();
    for (const f of this.files.values()) {
      for (const b of walk(f.graph.blocks)) {
        this.blocks.set(b.id, b);
        this.blockFile.set(b.id, f);
      }
      if (f.graph.lang === 'python') {
        // Every dotted suffix of the path is a candidate module name.
        let mod = f.rel.replace(/\.py$/, '').replace(/\/__init__$/, '');
        const parts = mod.split('/');
        for (let i = 0; i < parts.length; i++) {
          mod = parts.slice(i).join('.');
          const list = this.pyModules.get(mod) ?? [];
          list.push(f);
          this.pyModules.set(mod, list);
        }
      } else if (f.graph.lang === 'java') {
        const pkg = f.graph.pkg ?? '';
        const list = this.javaPackages.get(pkg) ?? [];
        list.push(f);
        this.javaPackages.set(pkg, list);
        const addTypes = (blocks: Block[], prefix: string) => {
          for (const b of blocks) {
            if (!isContainer(b)) continue;
            const fqn = prefix ? `${prefix}.${b.name}` : b.name;
            this.javaTypes.set(fqn, { block: b, file: f });
            addTypes(b.children, fqn);
          }
        };
        addTypes(f.graph.blocks, pkg);
      }
    }
    this.resolveAll();
    this.dirty = false;
  }

  private ensure() {
    if (this.dirty) this.rebuild();
  }

  private resolveAll() {
    this.out.clear();
    this.in.clear();
    this.ext.clear();
    this.refIn.clear();
    this.linkCount = 0;
    for (const f of this.files.values()) {
      for (const b of walk(f.graph.blocks)) {
        const seen = new Set<string>();
        const outs: Link[] = [];
        const exts: string[] = [];
        const refSites: CallSite[] = [];
        for (const site of b.calls) {
          if (site.ref) {
            refSites.push(site);
            continue;
          }
          const targets = pickOverloads(this.resolveSite(f, b, site), site.argc);
          if (!targets.length) {
            const label = site.obj ? `${site.obj}.${site.name}` : site.name;
            if (!exts.includes(label)) exts.push(label);
            continue;
          }
          for (const t of targets) {
            if (t.id === b.id || seen.has(t.id)) continue;
            seen.add(t.id);
            outs.push({ id: t.id, at: site.line });
            const ins = this.in.get(t.id) ?? [];
            ins.push({ id: b.id, at: site.line });
            this.in.set(t.id, ins);
          }
        }
        // A function passed as a value. Only functions count, and a target
        // that is also called directly is already listed as a call.
        for (const site of refSites) {
          for (const t of this.resolveSite(f, b, site)) {
            if (!isCallable(t) || t.kind === 'ctor' || t.id === b.id || seen.has(t.id)) continue;
            seen.add(t.id);
            const refs = this.refIn.get(t.id) ?? [];
            refs.push({ id: b.id, at: site.line });
            this.refIn.set(t.id, refs);
          }
        }
        if (outs.length) {
          this.out.set(b.id, outs);
          this.linkCount += outs.length;
        }
        if (exts.length) this.ext.set(b.id, exts);
      }
    }
  }

  // ------------------------------------------------------- module lookup

  private pyModule(fromRel: string, module: string, level = 0): FileIndex | undefined {
    if (level > 0) {
      let dir = path.posix.dirname(fromRel);
      for (let i = 1; i < level; i++) dir = path.posix.dirname(dir);
      const sub = module ? module.split('.').join('/') : '';
      const base = sub ? (dir === '.' ? sub : `${dir}/${sub}`) : dir;
      return this.files.get(`${base}.py`) ?? this.files.get(`${base === '.' ? '' : base + '/'}__init__.py`);
    }
    const list = this.pyModules.get(module);
    if (!list?.length) return;
    if (list.length === 1) return list[0];
    // Prefer the candidate whose path matches the module exactly, then the closest one.
    let best = list[0];
    let bestScore = -1;
    for (const f of list) {
      const exact = f.rel === `${module.split('.').join('/')}.py` || f.rel === `${module.split('.').join('/')}/__init__.py`;
      const score = (exact ? 1000 : 0) + commonPrefix(f.rel, fromRel) * 10 - f.rel.length / 100;
      if (score > bestScore) {
        bestScore = score;
        best = f;
      }
    }
    return best;
  }

  private jsModule(fromRel: string, spec: string): FileIndex | undefined {
    if (!spec.startsWith('.') && !spec.startsWith('/')) return;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    for (const e of JS_EXTS) {
      const f = this.files.get(base + e);
      if (f) return f;
    }
  }

  private resolveImport(file: FileIndex, imp: ImportBinding, depth: number): Target[] {
    const lang = file.graph.lang;
    if (lang === 'python') {
      const mod = this.pyModule(file.rel, imp.module, imp.level);
      if (imp.imported === '*') return mod ? [{ module: mod }] : [];
      if (mod) {
        const r = this.resolveName(mod, imp.imported, undefined, depth + 1);
        if (r.length) return r;
      }
      const sub = this.pyModule(file.rel, imp.module ? `${imp.module}.${imp.imported}` : imp.imported, imp.level);
      return sub ? [{ module: sub }] : [];
    }
    if (lang === 'javascript') {
      const mod = this.jsModule(file.rel, imp.module);
      if (!mod) return [];
      if (imp.imported === '*') return [{ module: mod }];
      if (imp.imported === 'default') {
        return mod.graph.defaultExport ? this.resolveName(mod, mod.graph.defaultExport, undefined, depth + 1) : [{ module: mod }];
      }
      return this.resolveName(mod, imp.imported, undefined, depth + 1);
    }
    // Java
    if (imp.isStatic) {
      const cls = this.javaTypes.get(imp.module);
      return cls ? this.member(cls.block, imp.imported).map((block) => ({ block, file: cls.file })) : [];
    }
    const t = this.javaTypes.get(`${imp.module}.${imp.imported}`);
    return t ? [t] : [];
  }

  // ------------------------------------------------------- name lookup

  /** Resolve a bare name as seen from `from` (or from module level). */
  private resolveName(file: FileIndex, name: string, from: Block | undefined, depth = 0): Target[] {
    if (depth > MAX_DEPTH || !name) return [];
    const lang = file.graph.lang;
    // Enclosing scopes: nested defs, and for Java the members of enclosing classes.
    for (let s = from; s; s = s.parent) {
      if (isCallable(s)) {
        const hit = s.children.find((c) => c.name === name && (isCallable(c) || isContainer(c)));
        if (hit) return [{ block: hit, file }];
      } else if (lang === 'java' && isContainer(s)) {
        if (s.name === name) return [{ block: s, file }];
        const hits = this.member(s, name);
        if (hits.length) return hits.map((block) => ({ block, file: this.blockFile.get(block.id) ?? file }));
      }
    }
    const key = `${file.rel}\0${name}`;
    const cached = this.nameCache.get(key);
    if (cached) return cached;
    this.nameCache.set(key, []); // cycle guard
    const result = this.resolveModuleName(file, name, depth);
    this.nameCache.set(key, result);
    return result;
  }

  private resolveModuleName(file: FileIndex, name: string, depth: number): Target[] {
    const top = file.top.get(name);
    if (top) return [{ block: top, file }];
    const imps = file.graph.imports;
    for (const imp of imps) {
      if (imp.local === name) {
        const r = this.resolveImport(file, imp, depth);
        if (r.length) return r;
      }
    }
    const lang = file.graph.lang;
    if (lang === 'java') {
      for (const f of this.javaPackages.get(file.graph.pkg ?? '') ?? []) {
        const t = f.top.get(name);
        if (t) return [{ block: t, file: f }];
      }
    }
    for (const imp of imps) {
      if (imp.local !== '*') continue;
      if (lang === 'java') {
        if (imp.isStatic) {
          const cls = this.javaTypes.get(imp.module);
          const hits = cls ? this.member(cls.block, name) : [];
          if (hits.length) return hits.map((block) => ({ block, file: cls!.file }));
        } else {
          for (const f of this.javaPackages.get(imp.module) ?? []) {
            const t = f.top.get(name);
            if (t) return [{ block: t, file: f }];
          }
          const outer = this.javaTypes.get(`${imp.module}.${name}`);
          if (outer) return [outer];
        }
        continue;
      }
      const mod = lang === 'python' ? this.pyModule(file.rel, imp.module, imp.level) : this.jsModule(file.rel, imp.module);
      if (mod && mod !== file) {
        const r = this.resolveName(mod, name, undefined, depth + 1);
        if (r.length) return r;
      }
    }
    return [];
  }

  /** Resolve `a.b.c` step by step through modules and classes. */
  private resolveDotted(file: FileIndex, dotted: string, from: Block | undefined): Target[] {
    // Python `import a.b.c` binds the whole dotted path.
    if (file.graph.lang === 'python') {
      for (const imp of file.graph.imports) {
        if (imp.local === dotted && imp.imported === '*') {
          const m = this.pyModule(file.rel, imp.module, imp.level);
          if (m) return [{ module: m }];
        }
      }
    }
    if (file.graph.lang === 'java' && this.javaTypes.has(dotted)) return [this.javaTypes.get(dotted)!];
    const parts = dotted.split('.');
    let cur = this.resolveName(file, parts[0], from);
    for (let i = 1; i < parts.length && cur.length; i++) {
      cur = cur.flatMap((t) => this.step(t, parts[i]));
    }
    return cur;
  }

  private step(t: Target, name: string): Target[] {
    if ('module' in t) return this.resolveName(t.module, name, undefined, 1);
    if (isContainer(t.block)) return this.member(t.block, name).map((block) => ({ block, file: this.blockFile.get(block.id) ?? t.file }));
    return [];
  }

  /** Members of a class with that name, following base classes. */
  member(cls: Block, name: string, depth = 0, seen = new Set<string>()): Block[] {
    if (depth > MAX_DEPTH || seen.has(cls.id)) return [];
    seen.add(cls.id);
    const own = cls.children.filter((c) => c.name === name && (isCallable(c) || isContainer(c)));
    if (own.length) return own;
    for (const base of this.basesOf(cls)) {
      const r = this.member(base, name, depth + 1, seen);
      if (r.length) return r;
    }
    return [];
  }

  private basesOf(cls: Block): Block[] {
    if (!cls.bases?.length) return [];
    const file = this.blockFile.get(cls.id);
    if (!file) return [];
    const out: Block[] = [];
    for (const base of cls.bases) {
      for (const t of this.resolveDotted(file, base, cls.parent)) {
        if ('block' in t && isContainer(t.block)) out.push(t.block);
      }
    }
    return out;
  }

  private typeOf(file: FileIndex, from: Block, obj: string): string | undefined {
    const self = /^(self|this|cls)\.([\w$#]+)$/.exec(obj);
    if (self) {
      const cls = enclosingContainer(from);
      return cls ? this.fieldType(cls, self[2].replace(/^#/, '')) : undefined;
    }
    if (!/^[\w$]+$/.test(obj)) return;
    for (let s: Block | undefined = from; s; s = s.parent) {
      if (s.vars?.[obj]) return s.vars[obj];
      if (file.graph.lang === 'java' && isContainer(s)) {
        const t = this.fieldType(s, obj);
        if (t) return t;
      }
    }
    return file.moduleVars[obj];
  }

  private fieldType(cls: Block, field: string, depth = 0): string | undefined {
    if (cls.fieldTypes?.[field]) return cls.fieldTypes[field];
    if (depth > 3) return;
    for (const b of this.basesOf(cls)) {
      const t = this.fieldType(b, field, depth + 1);
      if (t) return t;
    }
  }

  private toCallable(targets: Target[]): Block[] {
    const out: Block[] = [];
    for (const t of targets) {
      if ('module' in t) {
        // Calling a module directly: JS `const f = require('./f'); f()`.
        const def = t.module.graph.defaultExport;
        if (def && t.module.top.get(def)) out.push(...ctorOf(t.module.top.get(def)!).filter((b) => isCallable(b) || isContainer(b)));
        continue;
      }
      if (isContainer(t.block)) out.push(...ctorOf(t.block));
      else if (isCallable(t.block)) out.push(t.block);
    }
    return out;
  }

  private resolveSite(file: FileIndex, from: Block, site: CallSite): Block[] {
    switch (site.kind) {
      case 'name':
        return this.toCallable(this.resolveName(file, site.name, from));
      case 'new':
        return this.toCallable(site.name.includes('.') ? this.resolveDotted(file, site.name, from) : this.resolveName(file, site.name, from));
      case 'self': {
        const cls = enclosingContainer(from);
        if (cls) return this.toCallable(this.member(cls, site.name).map((block) => ({ block, file })));
        // JS: `this.x()` inside `app.handle = function () {}` or `Foo.prototype.bar = function () {}`.
        const owner = topOf(from).name;
        const dot = owner.lastIndexOf('.');
        if (dot > 0) {
          const prefix = owner.slice(0, dot);
          const hit = file.top.get(`${prefix}.${site.name}`) ?? file.top.get(`${prefix}.prototype.${site.name}`);
          if (hit) return [hit];
        }
        return [];
      }
      case 'super': {
        const cls = enclosingContainer(from);
        if (!cls) return [];
        // `super().__init__()` / `super(x)` style constructor calls.
        const name = site.name;
        for (const base of this.basesOf(cls)) {
          const r = this.member(base, name);
          if (r.length) return r;
        }
        return [];
      }
      case 'member': {
        if (!site.obj) return [];
        const direct = file.top.get(`${site.obj}.${site.name}`);
        if (direct) return [direct];
        const type = this.typeOf(file, from, site.obj);
        if (type) {
          const proto = file.top.get(`${type}.prototype.${site.name}`);
          if (proto) return [proto];
          const classes = this.resolveDotted(file, type, from).filter((t): t is { block: Block; file: FileIndex } => 'block' in t && isContainer(t.block));
          const hits = classes.flatMap((c) => this.member(c.block, site.name));
          if (hits.length) return hits;
        }
        if (/^(self|this|cls)\./.test(site.obj)) return [];
        const recv = this.resolveDotted(file, site.obj, from);
        return this.toCallable(recv.flatMap((t) => this.step(t, site.name)));
      }
    }
  }

  // ------------------------------------------------------------ view

  blockAt(rel: string, line: number): Block | undefined {
    const g = this.files.get(rel)?.graph;
    if (!g) return;
    let found: Block | undefined;
    let list = g.blocks;
    for (;;) {
      const hit = list.find((b) => b.start <= line && line <= b.end);
      if (!hit) return found;
      found = hit;
      list = hit.children;
    }
  }

  block(id: string): Block | undefined {
    this.ensure();
    return this.blocks.get(id);
  }

  linksOf(id: string) {
    this.ensure();
    return { out: this.out.get(id) ?? [], in: this.in.get(id) ?? [], ext: this.ext.get(id) ?? [], refs: this.refIn.get(id) ?? [] };
  }

  ref(link: Link): Ref | undefined {
    const b = this.blocks.get(link.id);
    const f = this.blockFile.get(link.id);
    if (!b || !f) return;
    return { id: b.id, label: b.qual.replace(/#\d+$/, ''), rel: f.rel, line: b.defLine, kind: b.kind, at: link.at };
  }

  view(rel: string): ViewModel | undefined {
    this.ensure();
    const f = this.files.get(rel);
    if (!f) return;
    const links: ViewModel['links'] = {};
    const toView = (b: Block): ViewBlock => {
      const l = this.linksOf(b.id);
      const refs = (ls: Link[]) => ls.map((x) => this.ref(x)).filter((x): x is Ref => !!x);
      if (l.out.length || l.in.length || l.ext.length || l.refs.length) links[b.id] = { out: refs(l.out), in: refs(l.in), ext: l.ext, refs: refs(l.refs) };
      return {
        id: b.id,
        kind: b.kind,
        name: b.name,
        qual: b.qual,
        start: b.start,
        end: b.end,
        defLine: b.defLine,
        signature: b.signature,
        detail: b.detail,
        tag: b.tag,
        decorators: b.decorators,
        children: b.children.map(toView),
      };
    };
    let lines = 0;
    for (const x of this.files.values()) lines += x.graph.lineCount;
    return {
      rel,
      lang: f.graph.lang,
      engine: f.graph.engine ?? 'parser',
      lineCount: f.graph.lineCount,
      summary: f.graph.summary,
      blocks: f.graph.blocks.map(toView),
      links,
      stats: { files: this.files.size, lines, links: this.linkCount, indexing: this.indexing, truncated: this.truncated },
    };
  }
}

function topOf(b: Block): Block {
  while (b.parent) b = b.parent;
  return b;
}

/** Among same-named Java overloads, keep the ones whose parameter count fits the call. */
function pickOverloads(targets: Block[], argc: number | undefined): Block[] {
  if (argc === undefined || targets.length < 2) return targets;
  const fits = targets.filter((t) => !t.arity || (t.arity[0] <= argc && argc <= t.arity[1]));
  return fits.length ? fits : targets;
}

function enclosingContainer(b: Block | undefined): Block | undefined {
  while (b && !isContainer(b)) b = b.parent;
  return b;
}
