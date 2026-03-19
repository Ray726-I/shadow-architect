import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
  defaultModelForProvider,
  getProviderConfig,
  listModels,
  type ProviderName
} from '../provider';
import { Agent, type AgentMode } from '../agent/agent';
import { ToolExecutor } from '../agent/tools';
import { ShadowWorkspace, type ChatSession, type SessionMessage } from '../workspace/workspace';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'shadow-architect.chatView';
  private readonly agent: Agent;
  private currentSession: ChatSession | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly shadowWorkspace: ShadowWorkspace,
    workspacePath: string
  ) {
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

      if (message.type === 'ready') {
        this.handleReady(webviewView);
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

  private async handleReady(webviewView: vscode.WebviewView) {
    await this.ensureCurrentSession();

    if (!this.currentSession) {
      return;
    }

    webviewView.webview.postMessage({
      type: 'sessionLoaded',
      sessionId: this.currentSession.id,
      messages: this.currentSession.messages
    });
  }

  private async ensureCurrentSession() {
    if (this.currentSession) {
      return;
    }

    const sessions = await this.shadowWorkspace.listChatSessions();
    if (sessions.length > 0) {
      const latest = await this.shadowWorkspace.getChatSession(sessions[0].id);
      if (latest) {
        this.currentSession = latest;
        return;
      }
    }

    this.currentSession = this.createEmptySession();
    await this.shadowWorkspace.saveChatSession(this.currentSession);
  }

  private createEmptySession(): ChatSession {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      name: 'New Chat',
      createdAt: now,
      updatedAt: now,
      messages: []
    };
  }

  private buildSessionName(text: string): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    if (!compact) {
      return 'New Chat';
    }

    return compact.slice(0, 40);
  }

  private async appendToSession(message: SessionMessage) {
    try {
      await this.ensureCurrentSession();
      if (!this.currentSession) {
        return;
      }

      const isFirstUserMessage = message.role === 'user'
        && !this.currentSession.messages.some(item => item.role === 'user');

      this.currentSession.messages.push(message);
      if (isFirstUserMessage) {
        this.currentSession.name = this.buildSessionName(message.text);
      }

      this.currentSession.updatedAt = new Date().toISOString();
      await this.shadowWorkspace.saveChatSession(this.currentSession);
    } catch (error) {
      console.error('Failed to save chat session', error);
    }
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

    await this.appendToSession({ role: 'user', text });

    try {
      const reply = await this.agent.run({
        mode,
        userText: text
      });

      await this.appendToSession({ role: 'assistant', text: reply });

      webviewView.webview.postMessage({
        type: 'addMessage',
        role: 'assistant',
        content: reply
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed';
      const content = `Error: ${message}`;
      await this.appendToSession({ role: 'assistant', text: content });

      webviewView.webview.postMessage({
        type: 'addMessage',
        role: 'assistant',
        content
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
