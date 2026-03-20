import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
  defaultModelForProvider,
  getProviderConfig,
  listModels,
  type ProviderName
} from '../provider';
import { Agent, type AgentMode, type AgentEvent } from '../agent/agent';
import { ToolExecutor } from '../agent/tools';
import { ShadowWorkspace, type ChatSession, type SessionMessage } from '../workspace/workspace';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'shadow-architect.chatView';

  private readonly agent: Agent;
  private webviewView: vscode.WebviewView | null = null;
  private currentSession: ChatSession | null = null;
  private isRegisteredProject = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly shadowWorkspace: ShadowWorkspace,
    workspacePath: string
  ) {
    this.agent = new Agent(new ToolExecutor(workspacePath));
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    const configSubscription = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('shadow-architect.provider') || event.affectsConfiguration('shadow-architect.model')) {
        this.sendModelList(webviewView);
      }
    });

    webviewView.onDidDispose(() => {
      configSubscription.dispose();
      this.webviewView = null;
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

      if (message.type === 'getHistory') {
        this.sendHistoryList(webviewView);
        return;
      }

      if (message.type === 'loadSession') {
        this.handleLoadSession(webviewView, String(message.sessionId ?? ''));
        return;
      }

      if (message.type === 'deleteSession') {
        this.handleDeleteSession(webviewView, String(message.sessionId ?? ''));
        return;
      }

      if (message.type === 'newChat') {
        this.handleNewChat(webviewView);
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

  async initializeCurrentWorkspaceAsShadowProject(projectName?: string) {
    const defaultName = vscode.workspace.name || 'Shadow Project';
    const name = projectName?.trim() || defaultName;

    await this.shadowWorkspace.registerProject(name);
    this.isRegisteredProject = true;
    await this.shadowWorkspace.touchRegisteredProject();

    this.currentSession = this.createEmptySession();
    await this.shadowWorkspace.saveChatSession(this.currentSession);

    const currentSession = this.currentSession;
    if (this.webviewView && currentSession) {
      this.webviewView.webview.postMessage({
        type: 'projectStatus',
        isRegistered: true
      });

      this.webviewView.webview.postMessage({
        type: 'sessionLoaded',
        sessionId: currentSession.id,
        messages: currentSession.messages
      });

      await this.sendHistoryList(this.webviewView);
    }
  }

  async refreshRegistrationState() {
    this.isRegisteredProject = await this.shadowWorkspace.isRegistered();
    if (!this.isRegisteredProject) {
      this.currentSession = null;
    }

    if (!this.webviewView) {
      return;
    }

    this.webviewView.webview.postMessage({
      type: 'projectStatus',
      isRegistered: this.isRegisteredProject
    });

    if (!this.isRegisteredProject) {
      this.webviewView.webview.postMessage({
        type: 'sessionLoaded',
        sessionId: 'ephemeral',
        messages: []
      });
      this.webviewView.webview.postMessage({
        type: 'historyList',
        sessions: []
      });
      return;
    }

    await this.shadowWorkspace.touchRegisteredProject();
    const currentSession = await this.ensureCurrentSession();
    if (currentSession) {
      this.webviewView.webview.postMessage({
        type: 'sessionLoaded',
        sessionId: currentSession.id,
        messages: currentSession.messages
      });
    }
    await this.sendHistoryList(this.webviewView);
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

  private async handleReady(webviewView: vscode.WebviewView) {
    this.isRegisteredProject = await this.shadowWorkspace.isRegistered();

    webviewView.webview.postMessage({
      type: 'projectStatus',
      isRegistered: this.isRegisteredProject
    });

    if (!this.isRegisteredProject) {
      this.currentSession = null;
      webviewView.webview.postMessage({
        type: 'sessionLoaded',
        sessionId: 'ephemeral',
        messages: []
      });
      webviewView.webview.postMessage({
        type: 'historyList',
        sessions: []
      });
      return;
    }

    await this.shadowWorkspace.touchRegisteredProject();
    const currentSession = await this.ensureCurrentSession();

    if (currentSession) {
      webviewView.webview.postMessage({
        type: 'sessionLoaded',
        sessionId: currentSession.id,
        messages: currentSession.messages
      });
    }

    await this.sendHistoryList(webviewView);
  }

  private async ensureCurrentSession(): Promise<ChatSession | null> {
    if (!this.isRegisteredProject) {
      this.currentSession = null;
      return null;
    }

    if (this.currentSession) {
      return this.currentSession;
    }

    const sessions = await this.shadowWorkspace.listChatSessions();
    if (sessions.length > 0) {
      const latest = await this.shadowWorkspace.getChatSession(sessions[0].id);
      if (latest) {
        this.currentSession = latest;
        return this.currentSession;
      }
    }

    this.currentSession = this.createEmptySession();
    await this.shadowWorkspace.saveChatSession(this.currentSession);
    return this.currentSession;
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
    if (!this.isRegisteredProject) {
      return;
    }

    try {
      const currentSession = await this.ensureCurrentSession();
      if (!currentSession) {
        return;
      }

      const isFirstUserMessage = message.role === 'user'
        && !currentSession.messages.some(item => item.role === 'user');

      currentSession.messages.push(message);
      if (isFirstUserMessage) {
        currentSession.name = this.buildSessionName(message.text);
      }

      currentSession.updatedAt = new Date().toISOString();
      await this.shadowWorkspace.saveChatSession(currentSession);
      await this.sendHistoryList();
    } catch (error) {
      console.error('Failed to save chat session', error);
    }
  }

  private async appendProjectHistory(mode: AgentMode, role: 'user' | 'assistant', content: string) {
    if (!this.isRegisteredProject) {
      return;
    }

    try {
      await this.shadowWorkspace.appendHistory({
        timestamp: new Date().toISOString(),
        mode,
        role,
        content
      });
    } catch (error) {
      console.error('Failed to append project history', error);
    }
  }

  private async sendHistoryList(view?: vscode.WebviewView) {
    const target = view ?? this.webviewView;
    if (!target) {
      return;
    }

    if (!this.isRegisteredProject) {
      target.webview.postMessage({
        type: 'historyList',
        sessions: []
      });
      return;
    }

    const sessions = await this.shadowWorkspace.listChatSessions();
    target.webview.postMessage({
      type: 'historyList',
      sessions
    });
  }

  private async handleLoadSession(webviewView: vscode.WebviewView, sessionId: string) {
    if (!this.isRegisteredProject) {
      return;
    }

    const id = sessionId.trim();
    if (!id) {
      return;
    }

    const session = await this.shadowWorkspace.getChatSession(id);
    if (!session) {
      return;
    }

    this.currentSession = session;
    webviewView.webview.postMessage({
      type: 'sessionLoaded',
      sessionId: session.id,
      messages: session.messages
    });
  }

  private async handleDeleteSession(webviewView: vscode.WebviewView, sessionId: string) {
    if (!this.isRegisteredProject) {
      return;
    }

    const id = sessionId.trim();
    if (!id) {
      return;
    }

    const deletingCurrent = this.currentSession?.id === id;
    await this.shadowWorkspace.deleteChatSession(id);

    if (deletingCurrent) {
      this.currentSession = null;
      const currentSession = await this.ensureCurrentSession();

      if (currentSession) {
        webviewView.webview.postMessage({
          type: 'sessionLoaded',
          sessionId: currentSession.id,
          messages: currentSession.messages
        });
      } else {
        webviewView.webview.postMessage({
          type: 'sessionLoaded',
          sessionId: 'ephemeral',
          messages: []
        });
      }
    }

    await this.sendHistoryList(webviewView);
  }

  private async handleNewChat(webviewView: vscode.WebviewView) {
    if (!this.isRegisteredProject) {
      this.currentSession = null;
      webviewView.webview.postMessage({
        type: 'sessionLoaded',
        sessionId: 'ephemeral',
        messages: []
      });
      return;
    }

    this.currentSession = this.createEmptySession();
    await this.shadowWorkspace.saveChatSession(this.currentSession);
    webviewView.webview.postMessage({
      type: 'sessionLoaded',
      sessionId: this.currentSession.id,
      messages: []
    });
    await this.sendHistoryList(webviewView);
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

    if (this.isRegisteredProject) {
      await this.appendToSession({ role: 'user', text });
      await this.appendProjectHistory(mode, 'user', text);
    }

    try {
      webviewView.webview.postMessage({
        type: 'chatStart',
        mode
      });

      const reply = await this.agent.run({
        mode,
        userText: text,
        onEvent: event => this.forwardAgentEvent(webviewView, event)
      });

      if (this.isRegisteredProject) {
        await this.appendToSession({ role: 'assistant', text: reply });
        await this.appendProjectHistory(mode, 'assistant', reply);
      }

      webviewView.webview.postMessage({
        type: 'addMessage',
        role: 'assistant',
        content: reply
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed';
      const content = `Error: ${message}`;

      if (this.isRegisteredProject) {
        await this.appendToSession({ role: 'assistant', text: content });
        await this.appendProjectHistory(mode, 'assistant', content);
      }

      webviewView.webview.postMessage({
        type: 'addMessage',
        role: 'assistant',
        content
      });
    } finally {
      webviewView.webview.postMessage({
        type: 'chatEnd',
        mode
      });
    }
  }

  private forwardAgentEvent(webviewView: vscode.WebviewView, event: AgentEvent) {
    webviewView.webview.postMessage({
      type: 'agentEvent',
      event
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css')
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js')
    );
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'marked.min.js')
    );
    const highlightUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'highlight.min.js')
    );
    const domPurifyUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'dompurify.min.js')
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
    <div id="model-controls">
      <label for="provider">AI</label>
      <select id="provider">
        <option value="ollama">Ollama</option>
        <option value="openai">OpenAI</option>
      </select>
      <select id="model"></select>
    </div>
    <div id="toolbar-actions">
      <button id="new-chat-icon" class="icon-btn" title="New Chat" aria-label="New Chat">
        <span aria-hidden="true">+</span>
      </button>
      <button id="history-toggle" class="icon-btn" title="History" aria-label="History">
        <span aria-hidden="true">🕘</span>
      </button>
    </div>
  </div>
  <div id="history-panel" hidden>
    <div id="history-title">History</div>
    <div id="history-empty"></div>
    <div id="history-list"></div>
  </div>
  <div id="messages"></div>
  <div id="typing" class="typing hidden">
    <span></span>
    <span></span>
    <span></span>
  </div>
  <div id="mode-row">
    <button class="mode-btn active" data-mode="chat">Chat</button>
    <button class="mode-btn" data-mode="fix">Fix</button>
    <button class="mode-btn" data-mode="build">Build</button>
  </div>
  <div id="input-row">
    <textarea id="input" rows="2" placeholder="Ask anything..."></textarea>
    <button id="send">Send</button>
  </div>
  <div id="status-bar"></div>
  <script src="${markedUri}"></script>
  <script src="${highlightUri}"></script>
  <script src="${domPurifyUri}"></script>
  <script src="${jsUri}"></script>
</body>
</html>`;
  }
}
