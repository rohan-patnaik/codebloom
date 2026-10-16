import * as vscode from 'vscode';
import { chooseLanguages, enabledLanguages, languageName, setLanguageEnabled } from './languages';
import { MapPanel } from './panel';
import { MapService } from './service';

export function activate(ctx: vscode.ExtensionContext) {
  const service = new MapService(vscode.Uri.joinPath(ctx.extensionUri, 'dist').fsPath);
  ctx.subscriptions.push(service);

  // Menus and the keybinding read this to show up only for mapped languages.
  const publishLanguages = () => void vscode.commands.executeCommand('setContext', 'codebloom.languages', [...enabledLanguages()]);
  publishLanguages();

  const targetUri = (arg?: unknown) => {
    if (arg instanceof vscode.Uri) return arg;
    return vscode.window.activeTextEditor?.document.uri;
  };

  /** Explain why a file can't be mapped and offer the fix. */
  const explain = async (doc: vscode.TextDocument) => {
    const name = languageName(doc.languageId);
    if (enabledLanguages().has(doc.languageId)) {
      void vscode.window.showInformationMessage(`Codebloom can't map ${name} files opened from here.`);
      return;
    }
    const enable = `Map ${name} files`;
    const pick = await vscode.window.showInformationMessage(`Codebloom isn't mapping ${name} files.`, enable, 'Choose languages…');
    if (pick === enable) {
      await setLanguageEnabled(doc.languageId, true);
      MapPanel.show(ctx, service, doc.uri);
    } else if (pick) await chooseLanguages();
  };

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codebloom.languages')) publishLanguages();
    }),
    vscode.commands.registerCommand('codebloom.openMap', async (arg?: unknown) => {
      const uri = targetUri(arg);
      if (uri) {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (!service.isSupported(doc)) return explain(doc);
      }
      MapPanel.show(ctx, service, uri);
    }),
    vscode.commands.registerCommand('codebloom.openMapInTab', async (arg?: unknown) => {
      const uri = targetUri(arg);
      if (uri) {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (!service.isSupported(doc)) return explain(doc);
      }
      MapPanel.show(ctx, service, uri, 'tab');
    }),
    vscode.commands.registerCommand('codebloom.openMapForFile', async (uri?: vscode.Uri) => {
      const target = targetUri(uri);
      if (target) {
        const doc = await vscode.workspace.openTextDocument(target);
        if (!service.isSupported(doc)) return explain(doc);
      }
      MapPanel.show(ctx, service, target);
    }),
    vscode.commands.registerCommand('codebloom.copyBlockContext', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      if (!service.isSupported(ed.document)) return explain(ed.document);
      const rel = await service.update(ed.document);
      if (!rel) return;
      const block = service.project.blockAt(rel, ed.selection.active.line + 1);
      await vscode.env.clipboard.writeText(await service.contextFor(rel, block, ed.document.getText()));
      vscode.window.setStatusBarMessage(`$(clippy) Codebloom: copied ${block ? block.qual.replace(/#\d+$/, '') : rel} as context`, 2500);
    }),
    vscode.commands.registerCommand('codebloom.reindex', () => service.reindex()),
    vscode.commands.registerCommand('codebloom.chooseLanguages', () => chooseLanguages()),
    vscode.commands.registerCommand('codebloom.toggleMaximize', async () => {
      if (!MapPanel.current) await vscode.commands.executeCommand('codebloom.openMap');
      await MapPanel.current?.toggleMaximize();
    }),
    vscode.window.registerWebviewPanelSerializer(MapPanel.viewType, {
      async deserializeWebviewPanel(panel, state) {
        MapPanel.revive(panel, ctx, service, state as { uri?: string } | undefined);
      },
    }),
  );
  // Used by the integration tests.
  return { service, panel: () => MapPanel.current };
}

export function deactivate() {}
