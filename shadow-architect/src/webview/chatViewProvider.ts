import * as vscode from 'vscode';
import {
  defaultModelForProvider,
  getProviderConfig,
  listModels,
  type ProviderName
} from '../provider';
import { Agent, type AgentMode } from '../agent/agent';
import { ToolExecutor } from '../agent/tools';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'shadow-architect.chatView';
  private readonly agent: Agent;

  constructor(private readonly _extensionUri: vscode.Uri) {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    this.agent = new Agent(new ToolExecutor(workspacePath));
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    const configSubscription = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('shadow-architect.provider') || event.affectsConfiguration('shadow-architect.model')) {
        this.sendModelList(webviewView);
      }
    });
    webviewView.onDidDispose(() => {
      configSubscription.dispose();
    });

    webviewView.webview.onDidReceiveMessage(message => {
      if (message.type === 'chat') {
        const mode = this.normalizeMode(String(message.mode ?? 'chat'));
        this.handleChatMessage(webviewView, String(message.text ?? ''), mode);
        return;
      }

      if (message.type === 'getProviderConfig') {
        this.sendModelList(webviewView);
        return;
      }

      if (message.type === 'setProvider') {
        this.handleSetProvider(webviewView, String(message.provider ?? ''));
        return;
      }

      if (message.type === 'setModel') {
        this.handleSetModel(webviewView, String(message.model ?? ''));
      }
    });
  }

  private normalizeMode(mode: string): AgentMode {
    if (mode === 'fix') {
      return 'fix';
    }
    if (mode === 'build') {
      return 'build';
    }
    return 'chat';
  }

  private async handleSetProvider(webviewView: vscode.WebviewView, provider: string) {
    const normalized: ProviderName = provider === 'openai' ? 'openai' : 'ollama';
    const nextModel = defaultModelForProvider(normalized);

    await vscode.workspace
      .getConfiguration('shadow-architect')
      .update('provider', normalized, vscode.ConfigurationTarget.Global);

    await vscode.workspace
      .getConfiguration('shadow-architect')
      .update('model', nextModel, vscode.ConfigurationTarget.Global);

    await this.sendModelList(webviewView);
  }

  private async handleSetModel(webviewView: vscode.WebviewView, model: string) {
    const trimmed = model.trim();
    if (!trimmed) {
      return;
    }

    await vscode.workspace
      .getConfiguration('shadow-architect')
      .update('model', trimmed, vscode.ConfigurationTarget.Global);

    await this.sendModelList(webviewView);
  }

  private async sendModelList(webviewView: vscode.WebviewView) {
    const config = getProviderConfig();
    const models = await listModels(config.provider).catch(() => [] as string[]);
    const selectedModel = models.includes(config.model)
      ? config.model
      : models[0] ?? config.model;

    if (selectedModel !== config.model) {
      await vscode.workspace
        .getConfiguration('shadow-architect')
        .update('model', selectedModel, vscode.ConfigurationTarget.Global);
    }

    webviewView.webview.postMessage({
      type: 'providerInfo',
      provider: config.provider,
      model: selectedModel,
      models
    });
  }

  private async handleChatMessage(webviewView: vscode.WebviewView, userText: string, mode: AgentMode) {
    const text = userText.trim();
    if (!text) {
      return;
    }

    try {
      const reply = await this.agent.run({
        mode,
        userText: text
      });

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
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'vendor', 'marked.min.js')
    );
    const highlightUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'vendor', 'highlight.min.js')
    );
    const domPurifyUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'vendor', 'dompurify.min.js')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="toolbar">
    <label for="provider">AI</label>
    <select id="provider">
      <option value="ollama">Ollama</option>
      <option value="openai">OpenAI</option>
    </select>
    <select id="model"></select>
  </div>
  <div id="messages"></div>
  <div id="mode-row">
    <button class="mode-btn active" data-mode="chat">Chat</button>
    <button class="mode-btn" data-mode="fix">Fix</button>
    <button class="mode-btn" data-mode="build">Build</button>
  </div>
  <div id="input-row">
    <textarea id="input" rows="2" placeholder="Ask anything..."></textarea>
    <button id="send">Send</button>
  </div>
  <script src="${markedUri}"></script>
  <script src="${highlightUri}"></script>
  <script src="${domPurifyUri}"></script>
  <script src="${jsUri}"></script>
</body>
</html>`;
  }
}
