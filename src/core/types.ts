// Language-neutral graph model. Everything after parsing works on these shapes,
// so the resolver and the webview never care which language a file came from.

export type Lang = 'python' | 'java' | 'javascript';

export type BlockKind =
  | 'doc'
  | 'imports'
  | 'globals'
  | 'fields'
  | 'class'
  | 'interface'
  | 'enum'
  | 'function'
  | 'method'
  | 'ctor'
  | 'main'
  | 'script';

export interface CallSite {
  /** name: foo()   self: self.foo()/this.foo()   super: super().foo()   member: x.foo()   new: new Foo() */
  kind: 'name' | 'self' | 'super' | 'member' | 'new';
  name: string;
  /** Receiver text for member calls, e.g. "engine" or "self.engine" or "a.b". */
  obj?: string;
  line: number;
  /** Argument count, used to pick between Java overloads. */
  argc?: number;
}

export interface Block {
  id: string;
  kind: BlockKind;
  name: string;
  /** Dotted path inside the file, e.g. "Trader.place_entry". Unique per file. */
  qual: string;
  /** 1-based inclusive line range, including the comments directly above. */
  start: number;
  end: number;
  /** Line of the declaration itself (after decorators/comments). */
  defLine: number;
  signature?: string;
  /** Java: [min, max] parameter count, for overload matching. */
  arity?: [number, number];
  /** Short summary for group blocks: imported modules, assigned names, etc. */
  detail?: string;
  bases?: string[];
  children: Block[];
  calls: CallSite[];
  /** Local variable name -> type name, from `x = Foo()`, `Foo x = ...`, `x: Foo`. */
  vars?: Record<string, string>;
  /** For classes: field name -> type name (self.x = Foo(), private Foo x;). */
  fieldTypes?: Record<string, string>;
  parent?: Block;
}

export interface ImportBinding {
  /** Name bound in this file. "*" for star/wildcard imports. */
  local: string;
  /** Module as written: "a.b", "./util", "com.x.Foo". */
  module: string;
  /** Imported member, "*" for the whole module, "default" for JS default import. */
  imported: string;
  /** Python relative-import level (number of leading dots). */
  level?: number;
  /** Java static import. */
  isStatic?: boolean;
}

export interface FileGraph {
  rel: string;
  lang: Lang;
  lineCount: number;
  blocks: Block[];
  imports: ImportBinding[];
  /** Java package name. */
  pkg?: string;
  /** JS: name of the block that is the default export. */
  defaultExport?: string;
  /** Docstring / header comment summary. */
  summary?: string;
}

/** Walk a block tree depth-first. */
export function* walk(blocks: Block[]): Generator<Block> {
  for (const b of blocks) {
    yield b;
    yield* walk(b.children);
  }
}

export function isContainer(b: Block): boolean {
  return b.kind === 'class' || b.kind === 'interface' || b.kind === 'enum';
}

export function isCallable(b: Block): boolean {
  return b.kind === 'function' || b.kind === 'method' || b.kind === 'ctor';
}
