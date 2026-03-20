const vscode = acquireVsCodeApi();
const messages = document.getElementById('messages');
const input = document.getElementById('input');
const send = document.getElementById('send');
const provider = document.getElementById('provider');
const model = document.getElementById('model');
const modeButtons = document.querySelectorAll('.mode-btn');
const newChatIcon = document.getElementById('new-chat-icon');
const historyToggle = document.getElementById('history-toggle');
const historyPanel = document.getElementById('history-panel');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
let currentMode = 'chat';
let activeSessionId = '';
let isRegisteredProject = false;
let isHistoryOpen = false;

function renderAssistantHtml(content) {
  if (!window.marked || !window.DOMPurify) {
    return content;
  }

  const html = window.marked.parse(content, {
    gfm: true,
    breaks: true
  });

  return window.DOMPurify.sanitize(html);
}

function highlightCodeBlocks(container) {
  if (!window.hljs) {
    return;
  }

  const blocks = container.querySelectorAll('pre code');
  for (const block of blocks) {
    window.hljs.highlightElement(block);
  }
}

function setModelOptions(models, selectedModel) {
  model.innerHTML = '';
  for (const item of models) {
    const option = document.createElement('option');
    option.value = item;
    option.textContent = item;
    model.appendChild(option);
  }

  if (selectedModel) {
    model.value = selectedModel;
  }
}

function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = 'message ' + role;

  if (role === 'assistant') {
    div.innerHTML = renderAssistantHtml(content);
    highlightCodeBlocks(div);
  } else {
    div.textContent = content;
  }

  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function clearMessages() {
  messages.innerHTML = '';
}

function formatDate(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function setHistoryOpen(next) {
  isHistoryOpen = next;
  historyPanel.hidden = !next;
  historyToggle.classList.toggle('active', next);
}

function renderHistoryList(sessions) {
  historyList.innerHTML = '';

  if (!isRegisteredProject) {
    historyEmpty.textContent = 'Initialize this workspace as a Shadow Project to save and browse history.';
    historyEmpty.hidden = false;
    return;
  }

  const items = Array.isArray(sessions) ? sessions : [];
  if (items.length === 0) {
    historyEmpty.textContent = 'No chat history yet.';
    historyEmpty.hidden = false;
    return;
  }

  historyEmpty.hidden = true;

  for (const session of items) {
    const row = document.createElement('div');
    row.className = 'history-row';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item';
    if (session.id === activeSessionId) {
      button.classList.add('active');
    }

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = session.name || 'Untitled';

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const count = Number.isFinite(session.messageCount) ? `${session.messageCount} msgs` : '';
    const updated = formatDate(session.updatedAt);
    meta.textContent = [count, updated].filter(Boolean).join(' • ');

    button.appendChild(title);
    button.appendChild(meta);
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'loadSession', sessionId: session.id });
      setHistoryOpen(false);
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'history-delete';
    deleteButton.title = 'Delete chat';
    deleteButton.setAttribute('aria-label', 'Delete chat');
    deleteButton.textContent = '🗑';
    deleteButton.addEventListener('click', event => {
      event.stopPropagation();

      const ok = window.confirm(`Delete chat "${session.name || 'Untitled'}"?`);
      if (!ok) {
        return;
      }

      vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
    });

    row.appendChild(button);
    row.appendChild(deleteButton);
    historyList.appendChild(row);
  }
}

send.onclick = () => {
  const text = input.value.trim();
  if (!text) return;
  addMessage('user', text);
  vscode.postMessage({ type: 'chat', text, mode: currentMode });
  input.value = '';
};

for (const button of modeButtons) {
  button.addEventListener('click', () => {
    currentMode = button.dataset.mode || 'chat';
    for (const item of modeButtons) {
      item.classList.toggle('active', item === button);
    }
  });
}

historyToggle.addEventListener('click', () => {
  setHistoryOpen(!isHistoryOpen);
  if (isHistoryOpen) {
    vscode.postMessage({ type: 'getHistory' });
  }
});

newChatIcon.addEventListener('click', () => {
  vscode.postMessage({ type: 'newChat' });
  setHistoryOpen(false);
});

document.addEventListener('click', event => {
  if (!isHistoryOpen) {
    return;
  }

  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }

  const insideHistory = historyPanel.contains(target);
  const insideHistoryButton = historyToggle.contains(target);
  if (!insideHistory && !insideHistoryButton) {
    setHistoryOpen(false);
  }
});

provider.addEventListener('change', () => {
  vscode.postMessage({ type: 'setProvider', provider: provider.value });
});

model.addEventListener('change', () => {
  vscode.postMessage({ type: 'setModel', model: model.value });
});

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send.click();
  }
});

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'addMessage') {
    addMessage(msg.role, msg.content);
    return;
  }

  if (msg.type === 'providerInfo') {
    provider.value = msg.provider === 'openai' ? 'openai' : 'ollama';
    setModelOptions(Array.isArray(msg.models) ? msg.models : [], msg.model);
    return;
  }

  if (msg.type === 'sessionLoaded') {
    activeSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
    clearMessages();
    const sessionMessages = Array.isArray(msg.messages) ? msg.messages : [];
    for (const item of sessionMessages) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      const text = typeof item.text === 'string' ? item.text : '';
      if (!text) {
        continue;
      }
      addMessage(role, text);
    }
    vscode.postMessage({ type: 'getHistory' });
    return;
  }

  if (msg.type === 'historyList') {
    renderHistoryList(msg.sessions);
    return;
  }

  if (msg.type === 'projectStatus') {
    isRegisteredProject = Boolean(msg.isRegistered);
    historyToggle.disabled = !isRegisteredProject;
    if (!isRegisteredProject) {
      setHistoryOpen(false);
    }
    renderHistoryList([]);
  }
});

vscode.postMessage({ type: 'getProviderConfig' });
vscode.postMessage({ type: 'ready' });
