// Language-neutral graph model. Everything after parsing works on these shapes,
// so the resolver and the webview never care which language a file came from.

/** Languages with a bundled tree-sitter parser. */
export type Lang = 'python' | 'java' | 'javascript';

/**
 * Where a file's blocks came from: Codebloom's own parsers, or the document
 * symbols of whatever language extension VS Code has for that language.
 */
export type Engine = 'parser' | 'symbols';

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
  | 'script'
  | 'namespace'
  | 'section';

export interface CallSite {
  /** name: foo()   self: self.foo()/this.foo()   super: super().foo()   member: x.foo()   new: new Foo() */
  kind: 'name' | 'self' | 'super' | 'member' | 'new';
  name: string;
  /** Receiver text for member calls, e.g. "engine" or "self.engine" or "a.b". */
  obj?: string;
  line: number;
  /** Argument count, used to pick between Java overloads. */
  argc?: number;
  /**
   * The function is passed as a value rather than called: `add_node("x", fn)`,
   * `addEventListener("click", this.onClick)`, `{ handler }`. These link as
   * "referenced by" so callbacks don't look unused.
   */
  ref?: boolean;
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
  /** Column of the name on defLine (symbol-based files, for asking the language server about it). */
  defCol?: number;
  signature?: string;
  /** Label shown on the block's chip when the kind alone is too vague: "struct", "trait", "h2". */
  tag?: string;
  /** Decorators or annotations, e.g. "@app.route('/')". A hint that a framework calls the block. */
  decorators?: string[];
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
  /** A bundled parser language, or the VS Code language id for symbol-based files. */
  lang: string;
  engine?: Engine;
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
  return b.kind === 'class' || b.kind === 'interface' || b.kind === 'enum' || b.kind === 'namespace';
}

export function isCallable(b: Block): boolean {
  return b.kind === 'function' || b.kind === 'method' || b.kind === 'ctor';
}
