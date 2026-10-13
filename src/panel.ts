import * as vscode from 'vscode';
import type { MapService } from './service';

type FromWebview =
  | { type: 'ready' }
  | { type: 'reveal'; rel: string; line: number; endLine?: number; focus?: boolean }
  | { type: 'copyContext'; id?: string }
  | { type: 'mode'; mode: 'names' | 'code' };

const nonce = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
};

/** The single mind-map webview. It follows the active editor and mirrors its cursor. */
export class MapPanel implements vscode.Disposable {
  static readonly viewType = 'codebloom.map';
  static current?: MapPanel;

  private disposables: vscode.Disposable[] = [];
  private uri?: vscode.Uri;
  private rel?: string;
  private ready = false;
  private sentText?: string;
  private lastColumn: vscode.ViewColumn = vscode.ViewColumn.One;
  private postTimer?: NodeJS.Timeout;

  static show(ctx: vscode.ExtensionContext, service: MapService, uri: vscode.Uri | undefined) {
    if (MapPanel.current) {
      MapPanel.current.panel.reveal(undefined, true);
    } else {
      const panel = vscode.window.createWebviewPanel(
        MapPanel.viewType,
        'Codebloom',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        MapPanel.options(ctx),
      );
      MapPanel.current = new MapPanel(panel, ctx, service);
    }
    if (uri) void MapPanel.current.open(uri);
    return MapPanel.current;
  }

  static revive(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext, service: MapService, state: { uri?: string } | undefined) {
    panel.webview.options = MapPanel.options(ctx);
    MapPanel.current = new MapPanel(panel, ctx, service);
    const uri = state?.uri ? vscode.Uri.parse(state.uri) : vscode.window.activeTextEditor?.document.uri;
    if (uri) void MapPanel.current.open(uri);
  }

  private static options(ctx: vscode.ExtensionContext): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    };
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly ctx: vscode.ExtensionContext,
    private readonly service: MapService,
  ) {
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel-icon.svg');
    panel.webview.html = this.html();
    const active = vscode.window.activeTextEditor;
    if (active?.viewColumn) this.lastColumn = active.viewColumn;
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      service.onDidChange((rel) => {
        if (!rel || rel === this.rel || this.service.project.indexing === false) this.schedulePost();
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (!ed) return;
        if (ed.viewColumn) this.lastColumn = ed.viewColumn;
        const follow = vscode.workspace.getConfiguration('codebloom').get<boolean>('followActiveEditor', true);
        if (follow && this.service.isSupported(ed.document.uri) && ed.document.uri.toString() !== this.uri?.toString()) {
          void this.open(ed.document.uri);
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.uri.toString() !== this.uri?.toString()) return;
        if (!vscode.workspace.getConfiguration('codebloom').get<boolean>('syncCursor', true)) return;
        // Ignore selections we caused by clicking in the map.
        if (e.kind === undefined) return;
        void this.panel.webview.postMessage({ type: 'cursor', line: e.selections[0].active.line + 1 });
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('codebloom')) this.schedulePost();
      }),
    );
  }

  async open(uri: vscode.Uri) {
    if (!this.service.isSupported(uri)) return;
    this.uri = uri;
    const doc = await vscode.workspace.openTextDocument(uri);
    this.rel = await this.service.update(doc);
    this.panel.title = `Map · ${uri.path.split('/').pop()}`;
    this.service.ensureIndexed();
    this.sentText = undefined;
    this.post();
  }

  private schedulePost() {
    clearTimeout(this.postTimer);
    this.postTimer = setTimeout(() => this.post(), 60);
  }

  private post() {
    if (!this.ready || !this.rel || !this.uri) return;
    const model = this.service.project.view(this.rel);
    if (!model) return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.uri!.toString());
    const text = doc?.getText();
    const cfg = vscode.workspace.getConfiguration('codebloom');
    const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.uri!.toString());
    const sendText = text !== undefined && text !== this.sentText;
    if (sendText) this.sentText = text;
    void this.panel.webview.postMessage({
      type: 'model',
      model,
      uri: this.uri.toString(),
      text: sendText ? text : undefined,
      cursor: ed ? ed.selection.active.line + 1 : undefined,
      config: {
        mode: this.ctx.globalState.get<string>('codebloom.mode') ?? cfg.get<string>('defaultMode', 'names'),
        maxCardLines: cfg.get<number>('maxCardLines', 24),
      },
    });
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.sentText = undefined;
        this.post();
        return;
      case 'reveal': {
        const uri = m.rel === this.rel ? this.uri : this.service.uriOf(m.rel);
        if (!uri) return;
        const cfg = vscode.workspace.getConfiguration('codebloom');
        if (!m.focus && !cfg.get<boolean>('revealOnClick', true) && uri === this.uri) return;
        const start = new vscode.Position(Math.max(0, m.line - 1), 0);
        const end = m.endLine ? new vscode.Position(m.endLine - 1, 0) : start;
        const editor = await vscode.window.showTextDocument(uri, {
          viewColumn: this.lastColumn === this.panel.viewColumn ? vscode.ViewColumn.One : this.lastColumn,
          preserveFocus: !m.focus,
          preview: false,
        });
        editor.selection = new vscode.Selection(start, start);
        editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        if (uri !== this.uri) void this.open(uri);
        return;
      }
      case 'copyContext': {
        if (!this.rel || !this.uri) return;
        const doc = await vscode.workspace.openTextDocument(this.uri);
        const block = m.id ? this.service.project.block(m.id) : undefined;
        await vscode.env.clipboard.writeText(this.service.contextFor(this.rel, block, doc.getText()));
        vscode.window.setStatusBarMessage('$(clippy) Codebloom: copied block as context', 2500);
        return;
      }
      case 'mode':
        await this.ctx.globalState.update('codebloom.mode', m.mode);
        return;
    }
  }

  private html() {
    const w = this.panel.webview;
    const n = nonce();
    const asset = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', f));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; img-src ${w.cspSource} data:; font-src ${w.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('webview.css')}">
<title>Codebloom</title>
</head>
<body>
<div id="app"></div>
<script nonce="${n}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }

  dispose() {
    MapPanel.current = undefined;
    clearTimeout(this.postTimer);
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
