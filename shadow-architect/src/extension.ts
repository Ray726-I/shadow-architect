import * as vscode from 'vscode';
import { ChatViewProvider } from './webview/chatViewProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatViewProvider(context.extensionUri);

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
