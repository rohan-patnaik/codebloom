import * as vscode from 'vscode';
import { BUILT_IN_IDS, enabledLanguages, engineFor, languageName, PARSER_IDS, setLanguageEnabled } from './languages';
import type { MapService } from './service';

type FromWebview =
  | { type: 'ready' }
  | { type: 'reveal'; rel: string; uri?: string; line: number; endLine?: number; focus?: boolean }
  | { type: 'copyContext'; id?: string }
  | { type: 'mode'; mode: 'names' | 'code' }
  | { type: 'calls'; id: string }
  | { type: 'enableLanguage'; languageId: string }
  | { type: 'findExtension'; languageId: string }
  | { type: 'openSetting'; key: string }
  | { type: 'chooseLanguages' }
  | { type: 'maximize' };

/** Shown above the map when the editor moved to a file the map can't follow. */
interface Notice {
  kind: 'disabled' | 'unsupported';
  file: string;
  languageId: string;
  language: string;
}

const nonce = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
};

/** Text-only languages where offering a map makes no sense. */
const NEVER_MAP = new Set(['plaintext', 'log', 'Log', 'code-text-binary', 'search-result', 'scminput', 'git-commit', 'git-rebase', 'ignore']);

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
  private maximized = false;

  /** `location` overrides the `codebloom.openLocation` setting: "tab" opens (or moves) the map into the active editor group. */
  static show(ctx: vscode.ExtensionContext, service: MapService, uri: vscode.Uri | undefined, location?: 'beside' | 'tab') {
    const inTab = (location ?? vscode.workspace.getConfiguration('codebloom').get<string>('openLocation', 'beside')) === 'tab';
    if (MapPanel.current) {
      // Join the code's editor group (ViewColumn.Active doesn't move an existing webview).
      if (location === 'tab') MapPanel.current.panel.reveal(vscode.window.activeTextEditor?.viewColumn ?? MapPanel.current.lastColumn, false);
      else MapPanel.current.panel.reveal(undefined, true);
    } else {
      const panel = vscode.window.createWebviewPanel(
        MapPanel.viewType,
        'Codebloom',
        { viewColumn: inTab ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside, preserveFocus: !inTab },
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
        if (!this.rel) return;
        // Settings changes clear the index; map the current file again.
        if (!this.service.project.has(this.rel) && this.uri) {
          void this.open(this.uri);
          return;
        }
        if (!rel || rel === this.rel || this.service.project.indexing === false) this.schedulePost();
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (!ed) return;
        if (ed.viewColumn) this.lastColumn = ed.viewColumn;
        const follow = vscode.workspace.getConfiguration('codebloom').get<boolean>('followActiveEditor', true);
        if (ed.document.uri.toString() === this.uri?.toString()) {
          // Back on the mapped file: any "still showing" notice is stale.
          void this.panel.webview.postMessage({ type: 'notice', notice: null });
          return;
        }
        if (!follow) return;
        if (this.service.isSupported(ed.document)) void this.open(ed.document.uri);
        else this.notice(ed.document);
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

  /** Tell the user why the map didn't follow them to this file. */
  private notice(doc: vscode.TextDocument) {
    if (!['file', 'untitled', 'vscode-remote', 'vscode-vfs'].includes(doc.uri.scheme) || !this.ready) return;
    const id = doc.languageId;
    const notice: Notice = {
      kind: NEVER_MAP.has(id) || enabledLanguages().has(id) ? 'unsupported' : 'disabled',
      file: doc.uri.path.split('/').pop() ?? '',
      languageId: id,
      language: languageName(id),
    };
    void this.panel.webview.postMessage({ type: 'notice', notice });
  }

  async open(uri: vscode.Uri) {
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return;
    }
    if (!this.service.isSupported(doc)) {
      // The current file's language was just switched off: stop refreshing it.
      if (uri.toString() === this.uri?.toString()) this.rel = undefined;
      this.notice(doc);
      return;
    }
    this.uri = uri;
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
    const languageId = doc?.languageId ?? model.lang;
    void this.panel.webview.postMessage({
      type: 'model',
      model,
      uri: this.uri.toString(),
      text: sendText ? text : undefined,
      cursor: ed ? ed.selection.active.line + 1 : undefined,
      language: { id: languageId, name: languageName(languageId), builtIn: !!PARSER_IDS[languageId] || BUILT_IN_IDS.includes(languageId) },
      outline: this.service.outlineOf(this.rel),
      config: {
        mode: this.ctx.globalState.get<string>('codebloom.mode') ?? cfg.get<string>('defaultMode', 'names'),
        maxCardLines: cfg.get<number>('maxCardLines', 24),
        indexWorkspace: cfg.get<boolean>('indexWorkspace', true),
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
        const uri = m.uri ? vscode.Uri.parse(m.uri) : m.rel === this.rel ? this.uri : this.service.uriOf(m.rel);
        if (!uri) return;
        const same = uri.toString() === this.uri?.toString();
        const cfg = vscode.workspace.getConfiguration('codebloom');
        if (!m.focus && !cfg.get<boolean>('revealOnClick', true) && same) return;
        // When the map is a tab in the code's own editor group, only an explicit "go to code" may cover it.
        const sharesGroup = !m.focus && this.panel.viewColumn === this.lastColumn;
        if (!sharesGroup) {
          const start = new vscode.Position(Math.max(0, m.line - 1), 0);
          const end = m.endLine ? new vscode.Position(m.endLine - 1, 0) : start;
          const editor = await vscode.window.showTextDocument(uri, {
            viewColumn: this.lastColumn === this.panel.viewColumn ? vscode.ViewColumn.One : this.lastColumn,
            preserveFocus: !m.focus,
            preview: false,
          });
          editor.selection = new vscode.Selection(start, start);
          editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        if (!same) void this.open(uri);
        return;
      }
      case 'copyContext': {
        if (!this.rel || !this.uri) return;
        const doc = await vscode.workspace.openTextDocument(this.uri);
        const block = m.id ? this.service.project.block(m.id) : undefined;
        await vscode.env.clipboard.writeText(await this.service.contextFor(this.rel, block, doc.getText()));
        vscode.window.setStatusBarMessage('$(clippy) Codebloom: copied block as context', 2500);
        return;
      }
      case 'mode':
        await this.ctx.globalState.update('codebloom.mode', m.mode);
        return;
      case 'calls': {
        if (!this.rel) return;
        const rel = this.rel;
        const info = await this.service.callsFor(rel, m.id);
        if (rel === this.rel) void this.panel.webview.postMessage({ type: 'calls', id: m.id, ...info });
        return;
      }
      case 'enableLanguage': {
        // Detach from the current file first, so the settings change doesn't re-map it over the new one.
        const ed = vscode.window.activeTextEditor;
        if (ed?.document.languageId === m.languageId) this.rel = undefined;
        await setLanguageEnabled(m.languageId, true);
        if (ed && engineFor(ed.document)) await this.open(ed.document.uri);
        return;
      }
      case 'findExtension':
        await vscode.commands.executeCommand('workbench.extensions.search', `@category:"programming languages" ${languageName(m.languageId)}`);
        return;
      case 'openSetting':
        if (m.key.startsWith('codebloom.')) await vscode.commands.executeCommand('workbench.action.openSettings', m.key);
        return;
      case 'chooseLanguages':
        await vscode.commands.executeCommand('codebloom.chooseLanguages');
        return;
      case 'maximize':
        await this.toggleMaximize();
        return;
    }
  }

  /** Give the map the whole editor area, or hand it back. */
  async toggleMaximize() {
    this.panel.reveal(undefined, false);
    const cmds = await vscode.commands.getCommands(true);
    if (cmds.includes('workbench.action.toggleMaximizeEditorGroup')) {
      await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
    } else {
      await vscode.commands.executeCommand(this.maximized ? 'workbench.action.evenEditorWidths' : 'workbench.action.minimizeOtherEditors');
    }
    this.maximized = !this.maximized;
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
