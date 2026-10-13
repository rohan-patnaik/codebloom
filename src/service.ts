import * as vscode from 'vscode';
import { langOf, nestSymbols, Parsers, Project, symbolGraph, walk, wholeFileGraph, type Block, type SymbolLike } from './core';
import type { Ref } from './core/project';
import { engineFor, indexedExtensions } from './languages';

const MAX_FILE_BYTES = 1_500_000;
/** Language servers often answer with nothing while they start; ask again at these delays. */
const SYMBOL_RETRIES = [400, 900, 1800, 3500, 6000];
const CALL_TIMEOUT = 6000;

/** Outline state of a symbol-based file. */
export type OutlineState = 'ok' | 'waiting' | 'none';

export interface CallInfo {
  status: 'ok' | 'unavailable';
  out: Ref[];
  in: Ref[];
}

const timeout = <T>(p: Thenable<T>, ms: number): Promise<T | undefined> =>
  Promise.race([Promise.resolve(p), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

/**
 * Owns the parsers and the project index. Python, Java and JavaScript are
 * parsed in-process; every other language is mapped from the symbols its
 * VS Code language extension reports. Files open in an editor are read from
 * their live buffer; the rest of the workspace is indexed in the background
 * so calls link across files.
 */
export class MapService implements vscode.Disposable {
  readonly project = new Project();
  private parsers?: Promise<Parsers>;
  private uris = new Map<string, vscode.Uri>();
  private pending = new Map<string, NodeJS.Timeout>();
  private retries = new Map<string, NodeJS.Timeout>();
  private outline = new Map<string, OutlineState>();
  private calls = new Map<string, { version: number; info: CallInfo }>();
  private indexRun = 0;
  private indexed = false;
  private disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<string | undefined>();
  /** Fires with the rel path that changed, or undefined for bulk changes. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly wasmDir: string) {
    this.disposables.push(
      this.changed,
      vscode.workspace.onDidChangeTextDocument((e) => {
        // Only files already on a map need refreshing; until a map opens, edits cost nothing.
        if (!e.contentChanges.length || !this.isSupported(e.document)) return;
        if (this.indexed || this.project.has(this.relOf(e.document.uri))) this.schedule(e.document);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        // Fall back to the saved file on disk once the buffer is gone.
        if (doc.isDirty && engineFor(doc) === 'parser' && doc.uri.scheme === 'file') void this.updateFromDisk(doc.uri);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('codebloom.languages') || e.affectsConfiguration('codebloom.preferLanguageServer')) {
          // Different files are in scope now: start the index over.
          this.project.clear();
          this.uris.clear();
          this.outline.clear();
          this.calls.clear();
          if (this.indexed) void this.reindex();
          else this.changed.fire(undefined);
        } else if (e.affectsConfiguration('codebloom.exclude') || e.affectsConfiguration('codebloom.maxFiles') || e.affectsConfiguration('codebloom.indexWorkspace')) {
          if (this.indexed) void this.reindex();
        }
      }),
    );
  }

  isSupported(doc: Pick<vscode.TextDocument, 'uri' | 'languageId'>) {
    return !!engineFor(doc);
  }

  relOf(uri: vscode.Uri): string {
    if (uri.scheme === 'untitled') return uri.path;
    const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const rel = vscode.workspace.asRelativePath(uri, multi);
    return rel.split('\\').join('/');
  }

  uriOf(rel: string): vscode.Uri | undefined {
    return this.uris.get(rel);
  }

  outlineOf(rel: string): OutlineState | undefined {
    return this.outline.get(rel);
  }

  private getParsers() {
    // The runtime starts on first use; each grammar loads when a file needs it.
    this.parsers ??= Parsers.create(this.wasmDir, []);
    return this.parsers;
  }

  /** Map a document from its live buffer and update the index. */
  async update(doc: vscode.TextDocument): Promise<string | undefined> {
    const engine = engineFor(doc);
    if (!engine) return;
    const rel = this.relOf(doc.uri);
    if (engine === 'symbols') return this.updateSymbols(doc, rel, 0);
    const parsers = await this.getParsers();
    const graph = await parsers.parseAsync(rel, doc.getText(), langOf(doc.uri.path));
    if (!graph) return;
    this.uris.set(rel, doc.uri);
    this.project.set(graph);
    return rel;
  }

  private async updateSymbols(doc: vscode.TextDocument, rel: string, attempt: number): Promise<string> {
    clearTimeout(this.retries.get(rel));
    const version = doc.version;
    let raw: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
    try {
      raw = await timeout(vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', doc.uri), 8000);
    } catch {
      raw = undefined;
    }
    if (doc.version !== version && attempt > 0) return rel;
    const lines = doc.getText().split(/\r?\n/);
    if (raw?.length) {
      // VS Code's results often carry both shapes; only nest by hand when there's no tree.
      const symbols: SymbolLike[] =
        !('selectionRange' in raw[0])
          ? nestSymbols((raw as vscode.SymbolInformation[]).map((s) => ({ name: s.name, kind: s.kind, range: s.location.range, selectionRange: s.location.range })))
          : (raw as vscode.DocumentSymbol[]);
      this.project.set(symbolGraph(rel, doc.languageId, lines, symbols));
      this.outline.set(rel, 'ok');
    } else {
      // Show the file as one card while the language server warms up, then for good if it never answers.
      const known = this.outline.get(rel) === 'ok' && this.project.has(rel);
      const more = attempt < SYMBOL_RETRIES.length && lines.some((l) => l.trim());
      if (!known) {
        this.project.set(wholeFileGraph(rel, doc.languageId, lines.length));
        this.outline.set(rel, more ? 'waiting' : 'none');
      }
      if (more) {
        this.retries.set(
          rel,
          setTimeout(async () => {
            this.retries.delete(rel);
            if (doc.isClosed) return;
            await this.updateSymbols(doc, rel, attempt + 1);
            this.changed.fire(rel);
          }, SYMBOL_RETRIES[attempt]),
        );
      }
    }
    this.uris.set(rel, doc.uri);
    return rel;
  }

  private schedule(doc: vscode.TextDocument) {
    const key = doc.uri.toString();
    clearTimeout(this.pending.get(key));
    // Language servers need a moment to catch up with an edit.
    const delay = engineFor(doc) === 'symbols' ? 450 : 120;
    this.pending.set(
      key,
      setTimeout(async () => {
        this.pending.delete(key);
        const rel = await this.update(doc);
        if (rel) this.changed.fire(rel);
      }, delay),
    );
  }

  private async updateFromDisk(uri: vscode.Uri, notify = true) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) return;
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const parsers = await this.getParsers();
      const rel = this.relOf(uri);
      const graph = await parsers.parseAsync(rel, text);
      if (!graph) return;
      this.uris.set(rel, uri);
      this.project.set(graph);
      if (notify) this.changed.fire(rel);
    } catch {
      // Unreadable or vanished file: ignore.
    }
  }

  /** Start the background workspace index once. */
  ensureIndexed() {
    if (this.indexed) return;
    this.indexed = true;
    void this.reindex();
  }

  async reindex() {
    const run = ++this.indexRun;
    const cfg = vscode.workspace.getConfiguration('codebloom');
    this.project.truncated = undefined;
    const exts = indexedExtensions();
    this.watch(exts);
    if (!cfg.get<boolean>('indexWorkspace', true) || !vscode.workspace.workspaceFolders?.length || !exts.length) {
      this.changed.fire(undefined);
      return;
    }
    const exclude = cfg.get<string[]>('exclude', []);
    const max = cfg.get<number>('maxFiles', 4000);
    const glob = `**/*.{${exts.map((e) => e.slice(1)).join(',')}}`;
    this.project.indexing = true;
    this.changed.fire(undefined);
    try {
      // Ask for one extra file to learn whether the limit cut the index short.
      const found = await vscode.workspace.findFiles(glob, exclude.length ? `{${exclude.join(',')}}` : undefined, max + 1);
      if (found.length > max) this.project.truncated = max;
      const uris = found.slice(0, max);
      const parsers = await this.getParsers();
      let last = Date.now();
      for (let i = 0; i < uris.length; i++) {
        if (run !== this.indexRun) return;
        const uri = uris[i];
        const rel = this.relOf(uri);
        const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        try {
          let text: string;
          if (open) text = open.getText();
          else {
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.byteLength > MAX_FILE_BYTES) continue;
            text = new TextDecoder().decode(bytes);
          }
          const graph = await parsers.parseAsync(rel, text);
          if (graph) {
            this.uris.set(rel, uri);
            this.project.set(graph);
          }
        } catch {
          // skip unreadable files
        }
        // Stay responsive: yield to the extension host and refresh the view now and then.
        if (i % 40 === 39) await new Promise((r) => setImmediate(r));
        if (Date.now() - last > 1500) {
          last = Date.now();
          this.changed.fire(undefined);
        }
      }
    } finally {
      if (run === this.indexRun) {
        this.project.indexing = false;
        this.changed.fire(undefined);
      }
    }
  }

  private watcher?: vscode.Disposable;
  private watchedGlob = '';
  private watch(exts: string[]) {
    const glob = exts.length ? `**/*.{${exts.map((e) => e.slice(1)).join(',')}}` : '';
    if (glob === this.watchedGlob) return;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.watchedGlob = glob;
    if (!glob) return;
    const w = vscode.workspace.createFileSystemWatcher(glob);
    const excluded = (uri: vscode.Uri) => /[\\/](node_modules|\.git|venv|\.venv|__pycache__)[\\/]/.test(uri.fsPath);
    this.watcher = vscode.Disposable.from(
      w,
      w.onDidCreate((uri) => !excluded(uri) && void this.updateFromDisk(uri)),
      w.onDidChange((uri) => {
        // Open buffers are already tracked live.
        if (excluded(uri) || vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString() && d.isDirty)) return;
        void this.updateFromDisk(uri);
      }),
      w.onDidDelete((uri) => {
        const rel = this.relOf(uri);
        this.project.delete(rel);
        this.uris.delete(rel);
        this.changed.fire(undefined);
      }),
    );
  }

  // ------------------------------------------------------- language-server calls

  /** Calls and callers of a symbol-based block, from the language's call hierarchy. Cached per document version. */
  async callsFor(rel: string, id: string): Promise<CallInfo> {
    const none: CallInfo = { status: 'unavailable', out: [], in: [] };
    const uri = this.uris.get(rel);
    const block = this.project.block(id);
    if (!uri || !block) return none;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) ?? (await vscode.workspace.openTextDocument(uri));
    const cached = this.calls.get(id);
    if (cached && cached.version === doc.version) return cached.info;
    let info = none;
    try {
      const pos = new vscode.Position(block.defLine - 1, block.defCol ?? Math.max(0, doc.lineAt(block.defLine - 1).text.indexOf(block.name)));
      const items = await timeout(vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, pos), CALL_TIMEOUT);
      const item = items?.[0];
      if (item) {
        const [outs, ins] = await Promise.all([
          timeout(vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', item), CALL_TIMEOUT),
          timeout(vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item), CALL_TIMEOUT),
        ]);
        info = {
          status: 'ok',
          out: (outs ?? []).flatMap((c) => c.fromRanges.slice(0, 1).map((r) => this.refOf(c.to, r.start.line + 1))),
          in: (ins ?? []).flatMap((c) => c.fromRanges.slice(0, 1).map((r) => this.refOf(c.from, r.start.line + 1))),
        };
      }
    } catch {
      info = none;
    }
    this.calls.set(id, { version: doc.version, info });
    return info;
  }

  private refOf(item: vscode.CallHierarchyItem, at: number): Ref {
    const rel = this.relOf(item.uri);
    const line = item.selectionRange.start.line + 1;
    // Point at our own block when the target is in a mapped file, so arrows can be drawn.
    let id = `${rel}::@${line}:${item.name}`;
    const graph = this.project.graph(rel);
    if (graph) {
      for (const b of walk(graph.blocks)) {
        if (b.defLine === line) {
          id = b.id;
          break;
        }
      }
    }
    this.uris.set(rel, item.uri);
    return { id, label: item.name, rel, line, kind: vscode.SymbolKind[item.kind]?.toLowerCase() ?? 'symbol', at, uri: item.uri.toString() };
  }

  // ------------------------------------------------------- copy as context

  /** Text block for pasting into an LLM chat: code plus what it calls and what calls it. */
  async contextFor(rel: string, block: Block | undefined, text: string): Promise<string> {
    const lines = text.split(/\r?\n/);
    const graph = this.project.graph(rel);
    const lang = graph?.lang ?? '';
    if (!block) return `# ${rel}\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
    const code = lines.slice(block.start - 1, block.end).join('\n');
    const fmt = (ls: Ref[]) => [...new Set(ls.map((r) => `${r.label} (${r.rel}:${r.line})`))];
    let calls: string[];
    let callers: string[];
    let refs: string[] = [];
    let ext: string[] = [];
    if (graph?.engine === 'symbols') {
      const info = await this.callsFor(rel, block.id);
      calls = fmt(info.out);
      callers = fmt(info.in);
    } else {
      const l = this.project.linksOf(block.id);
      const refsOf = (ls: { id: string; at: number }[]) => ls.map((x) => this.project.ref(x)).filter((r): r is Ref => !!r);
      calls = fmt(refsOf(l.out));
      callers = fmt(refsOf(l.in));
      refs = fmt(refsOf(l.refs));
      ext = l.ext;
    }
    let out = `# ${rel} :: ${block.qual.replace(/#\d+$/, '')}  (lines ${block.start}-${block.end})\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    if (calls.length) out += `\nCalls:\n${calls.map((c) => `- ${c}`).join('\n')}\n`;
    if (callers.length) out += `\nCalled by:\n${callers.map((c) => `- ${c}`).join('\n')}\n`;
    if (refs.length) out += `\nPassed as a value by:\n${refs.map((c) => `- ${c}`).join('\n')}\n`;
    if (block.decorators?.length) out += `\nDecorators: ${block.decorators.join(', ')}\n`;
    if (ext.length) out += `\nUnlinked calls: ${ext.join(', ')}\n`;
    return out;
  }

  dispose() {
    this.indexRun++;
    for (const t of this.pending.values()) clearTimeout(t);
    for (const t of this.retries.values()) clearTimeout(t);
    this.watcher?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
