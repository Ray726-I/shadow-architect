import * as vscode from 'vscode';
import { createProvider } from '../provider';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'shadow-architect.chatView';

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(message => {
      if (message.type === 'chat') {
        this.handleChatMessage(webviewView, String(message.text ?? ''));
      }
    });
  }

  private async handleChatMessage(webviewView: vscode.WebviewView, userText: string) {
    const text = userText.trim();
    if (!text) {
      return;
    }

    try {
      const provider = createProvider();
      const reply = await provider.chat([
        { role: 'user', content: text }
      ]);

      webviewView.webview.postMessage({
        type: 'addMessage',
        role: 'assistant',
        content: reply
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed';
      webviewView.webview.postMessage({
        type: 'addMessage',
        role: 'assistant',
        content: `Error: ${message}`
      });
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.css')
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="messages"></div>
  <div id="input-row">
    <textarea id="input" rows="2" placeholder="Ask anything..."></textarea>
    <button id="send">Send</button>
  </div>
  <script src="${jsUri}"></script>
</body>
</html>`;
  }
}
