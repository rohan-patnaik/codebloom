import * as vscode from 'vscode';
import { langOf, Parsers, Project, SUPPORTED_EXTENSIONS, type Block } from './core';

const MAX_FILE_BYTES = 1_500_000;

/**
 * Owns the parsers and the project index. Files open in an editor are parsed
 * from their live buffer; the rest of the workspace is indexed in the
 * background so calls link across files.
 */
export class MapService implements vscode.Disposable {
  readonly project = new Project();
  private parsers?: Promise<Parsers>;
  private uris = new Map<string, vscode.Uri>();
  private pending = new Map<string, NodeJS.Timeout>();
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
        if (e.contentChanges.length && this.isSupported(e.document.uri)) this.schedule(e.document);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        // Fall back to the saved file on disk once the buffer is gone.
        if (doc.isDirty && this.isSupported(doc.uri) && doc.uri.scheme === 'file') void this.updateFromDisk(doc.uri);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('codebloom.exclude') || e.affectsConfiguration('codebloom.maxFiles') || e.affectsConfiguration('codebloom.indexWorkspace')) {
          if (this.indexed) void this.reindex();
        }
      }),
    );
  }

  isSupported(uri: vscode.Uri) {
    return (uri.scheme === 'file' || uri.scheme === 'untitled' || uri.scheme === 'vscode-remote') && !!langOf(uri.path);
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

  private getParsers() {
    this.parsers ??= Parsers.create(this.wasmDir);
    return this.parsers;
  }

  /** Parse a document from its live buffer and update the index. */
  async update(doc: vscode.TextDocument): Promise<string | undefined> {
    if (!this.isSupported(doc.uri)) return;
    const parsers = await this.getParsers();
    const rel = this.relOf(doc.uri);
    const graph = parsers.parse(rel, doc.getText(), langOf(doc.uri.path) ?? (doc.languageId as never));
    if (!graph) return;
    this.uris.set(rel, doc.uri);
    this.project.set(graph);
    return rel;
  }

  private schedule(doc: vscode.TextDocument) {
    const key = doc.uri.toString();
    clearTimeout(this.pending.get(key));
    this.pending.set(
      key,
      setTimeout(async () => {
        this.pending.delete(key);
        const rel = await this.update(doc);
        if (rel) this.changed.fire(rel);
      }, 120),
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
      const graph = parsers.parse(rel, text);
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
    if (!cfg.get<boolean>('indexWorkspace', true) || !vscode.workspace.workspaceFolders?.length) return;
    const exclude = cfg.get<string[]>('exclude', []);
    const max = cfg.get<number>('maxFiles', 4000);
    const glob = `**/*.{${SUPPORTED_EXTENSIONS.map((e) => e.slice(1)).join(',')}}`;
    this.project.indexing = true;
    this.changed.fire(undefined);
    try {
      const uris = await vscode.workspace.findFiles(glob, exclude.length ? `{${exclude.join(',')}}` : undefined, max);
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
          const graph = parsers.parse(rel, text);
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
    this.watch();
  }

  private watcher?: vscode.FileSystemWatcher;
  private watch() {
    if (this.watcher) return;
    const glob = `**/*.{${SUPPORTED_EXTENSIONS.map((e) => e.slice(1)).join(',')}}`;
    this.watcher = vscode.workspace.createFileSystemWatcher(glob);
    const excluded = (uri: vscode.Uri) => /[\\/](node_modules|\.git|venv|\.venv|__pycache__)[\\/]/.test(uri.fsPath);
    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate((uri) => !excluded(uri) && void this.updateFromDisk(uri)),
      this.watcher.onDidChange((uri) => {
        // Open buffers are already tracked live.
        if (excluded(uri) || vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString() && d.isDirty)) return;
        void this.updateFromDisk(uri);
      }),
      this.watcher.onDidDelete((uri) => {
        const rel = this.relOf(uri);
        this.project.delete(rel);
        this.uris.delete(rel);
        this.changed.fire(undefined);
      }),
    );
  }

  /** Text block for pasting into an LLM chat: code plus what it calls and what calls it. */
  contextFor(rel: string, block: Block | undefined, text: string): string {
    const lines = text.split(/\r?\n/);
    const lang = this.project.graph(rel)?.lang ?? '';
    if (!block) return `# ${rel}\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
    const code = lines.slice(block.start - 1, block.end).join('\n');
    const l = this.project.linksOf(block.id);
    const fmt = (ls: { id: string }[]) =>
      [...new Set(ls.map((x) => this.project.ref({ id: x.id, at: 0 })).filter(Boolean).map((r) => `${r!.label} (${r!.rel}:${r!.line})`))];
    let out = `# ${rel} :: ${block.qual.replace(/#\d+$/, '')}  (lines ${block.start}-${block.end})\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    const calls = fmt(l.out);
    const callers = fmt(l.in);
    if (calls.length) out += `\nCalls:\n${calls.map((c) => `- ${c}`).join('\n')}\n`;
    if (callers.length) out += `\nCalled by:\n${callers.map((c) => `- ${c}`).join('\n')}\n`;
    if (l.ext.length) out += `\nExternal calls: ${l.ext.join(', ')}\n`;
    return out;
  }

  dispose() {
    this.indexRun++;
    for (const t of this.pending.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}
