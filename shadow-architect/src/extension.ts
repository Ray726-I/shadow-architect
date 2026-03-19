import * as vscode from 'vscode';
import { ChatViewProvider } from './webview/chatViewProvider';
import { ShadowWorkspace } from './workspace/workspace';

export function activate(context: vscode.ExtensionContext) {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const shadowWorkspace = new ShadowWorkspace(context.globalStorageUri.fsPath, workspacePath);
  const provider = new ChatViewProvider(context.extensionUri, shadowWorkspace, workspacePath);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadow-architect.openChat', async () => {
      await vscode.commands.executeCommand('shadow-architect.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadow-architect.helloWorld', async () => {
      await vscode.commands.executeCommand('shadow-architect.chatView.focus');
    })
  );
}

export function deactivate() {}
