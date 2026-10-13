import * as vscode from 'vscode';
import { MapPanel } from './panel';
import { MapService } from './service';

export function activate(ctx: vscode.ExtensionContext) {
  const service = new MapService(vscode.Uri.joinPath(ctx.extensionUri, 'dist').fsPath);
  ctx.subscriptions.push(service);

  const targetUri = (arg?: unknown) => {
    if (arg instanceof vscode.Uri) return arg;
    return vscode.window.activeTextEditor?.document.uri;
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('codebloom.openMap', (arg?: unknown) => {
      const uri = targetUri(arg);
      if (uri && !service.isSupported(uri)) {
        void vscode.window.showInformationMessage('Codebloom maps Python, Java and JavaScript files. Open one of those and try again.');
        return;
      }
      MapPanel.show(ctx, service, uri);
    }),
    vscode.commands.registerCommand('codebloom.openMapForFile', (uri?: vscode.Uri) => {
      MapPanel.show(ctx, service, targetUri(uri));
    }),
    vscode.commands.registerCommand('codebloom.copyBlockContext', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || !service.isSupported(ed.document.uri)) return;
      const rel = await service.update(ed.document);
      if (!rel) return;
      const block = service.project.blockAt(rel, ed.selection.active.line + 1);
      await vscode.env.clipboard.writeText(service.contextFor(rel, block, ed.document.getText()));
      vscode.window.setStatusBarMessage(`$(clippy) Codebloom: copied ${block ? block.qual.replace(/#\d+$/, '') : rel} as context`, 2500);
    }),
    vscode.commands.registerCommand('codebloom.reindex', () => service.reindex()),
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
