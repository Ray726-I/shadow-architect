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
const typing = document.getElementById('typing');

let currentMode = 'chat';
let activeSessionId = '';
let isRegisteredProject = false;
let isHistoryOpen = false;
let activeTimeline = null;
let pendingModeSuggestion = null;

const MODE_LABELS = {
  chat: 'Chat',
  fix: 'Fix',
  build: 'Build'
};

function normalizeMode(mode) {
  if (mode === 'fix' || mode === 'build') {
    return mode;
  }
  return 'chat';
}

function setActiveMode(mode) {
  currentMode = normalizeMode(mode);
  for (const node of modeButtons) {
    node.classList.toggle('active', node.dataset.mode === currentMode);
  }
}

function clearModeSuggestion(options) {
  const pending = pendingModeSuggestion;
  if (!pending) {
    return;
  }

  window.clearTimeout(pending.autoTimer);
  window.clearInterval(pending.tickTimer);
  pending.card.remove();

  pendingModeSuggestion = null;

  if (options && options.notify) {
    vscode.postMessage({
      type: 'modeSuggestionResponse',
      suggestionId: pending.id,
      accepted: Boolean(options.accepted),
      selectedMode: normalizeMode(String(options.selectedMode || currentMode))
    });
  }
}

function showModeSuggestion(data) {
  clearModeSuggestion();

  const suggestionId = typeof data.suggestionId === 'string' ? data.suggestionId : '';
  if (!suggestionId) {
    return;
  }

  const suggestedMode = normalizeMode(String(data.suggestedMode || 'chat'));
  const seconds = Number.isFinite(data.seconds)
    ? Math.max(1, Math.floor(data.seconds))
    : 10;

  const card = document.createElement('div');
  card.className = 'mode-suggestion-card';

  const title = document.createElement('div');
  title.className = 'mode-suggestion-title';
  title.textContent = `Suggested mode: ${MODE_LABELS[suggestedMode]}`;

  const hint = document.createElement('div');
  hint.className = 'mode-suggestion-hint';

  const countdown = document.createElement('div');
  countdown.className = 'mode-suggestion-countdown';

  const actions = document.createElement('div');
  actions.className = 'mode-suggestion-actions';

  const switchBtn = document.createElement('button');
  switchBtn.type = 'button';
  switchBtn.className = 'mode-suggestion-btn switch';
  switchBtn.textContent = `Switch to ${MODE_LABELS[suggestedMode]}`;

  const stayBtn = document.createElement('button');
  stayBtn.type = 'button';
  stayBtn.className = 'mode-suggestion-btn stay';
  stayBtn.textContent = 'Stay in current mode';

  actions.appendChild(switchBtn);
  actions.appendChild(stayBtn);

  card.appendChild(title);
  card.appendChild(hint);
  card.appendChild(countdown);
  card.appendChild(actions);
  document.body.appendChild(card);

  const deadline = Date.now() + (seconds * 1000);

  const updateCountdown = () => {
    const remainingMs = Math.max(0, deadline - Date.now());
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    hint.textContent = 'Auto-switch will apply unless you cancel.';
    countdown.textContent = `Auto-switching in ${remainingSeconds}s`;
  };

  pendingModeSuggestion = {
    id: suggestionId,
    suggestedMode,
    card,
    autoTimer: window.setTimeout(() => {
      setActiveMode(suggestedMode);
      clearModeSuggestion({ notify: true, accepted: true, selectedMode: suggestedMode });
    }, seconds * 1000),
    tickTimer: window.setInterval(updateCountdown, 250)
  };

  switchBtn.addEventListener('click', () => {
    setActiveMode(suggestedMode);
    clearModeSuggestion({ notify: true, accepted: true, selectedMode: suggestedMode });
  });

  stayBtn.addEventListener('click', () => {
    clearModeSuggestion({ notify: true, accepted: false, selectedMode: currentMode });
  });

  updateCountdown();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderAssistantHtml(content) {
  if (!window.marked || !window.DOMPurify) {
    return escapeHtml(content);
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
  const item = document.createElement('div');
  item.className = `message ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  if (role === 'assistant') {
    bubble.classList.add('markdown-body');
    bubble.innerHTML = renderAssistantHtml(content);
    highlightCodeBlocks(bubble);
  } else {
    bubble.textContent = content;
  }

  item.appendChild(bubble);
  messages.appendChild(item);
  scrollToBottom();
}

function clearMessages() {
  messages.innerHTML = '';
  activeTimeline = null;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messages.scrollTop = messages.scrollHeight;
  });
}

function setHistoryOpen(next) {
  isHistoryOpen = next;
  historyPanel.hidden = !next;
  historyToggle.classList.toggle('active', next);
}

function setTyping(isVisible) {
  if (!typing) {
    return;
  }
  typing.classList.toggle('hidden', !isVisible);
}

function buildTimelineCard(mode) {
  const card = document.createElement('section');
  card.className = `agent-timeline ${mode}`;

  const header = document.createElement('div');
  header.className = 'timeline-header';

  const title = document.createElement('div');
  title.className = 'timeline-title';
  title.textContent = mode === 'fix' ? 'Fix Execution' : mode === 'build' ? 'Build Execution' : 'Agent Execution';

  const badge = document.createElement('div');
  badge.className = 'timeline-badge';
  badge.textContent = mode.toUpperCase();

  header.appendChild(title);
  header.appendChild(badge);

  const body = document.createElement('div');
  body.className = 'timeline-body';

  card.appendChild(header);
  card.appendChild(body);
  messages.appendChild(card);

  return {
    mode,
    card,
    body,
    lines: [],
    statusLine: null,
    activeToolLine: null,
    iterLine: null
  };
}

function addTimelineLine(text, kind) {
  if (!activeTimeline) {
    activeTimeline = buildTimelineCard(currentMode);
  }

  const line = document.createElement('div');
  line.className = `timeline-line ${kind || 'note'}`;
  line.textContent = text;
  activeTimeline.body.appendChild(line);
  activeTimeline.lines.push(line);
  scrollToBottom();
  return line;
}

function updateIterationLine(event) {
  if (!activeTimeline) {
    activeTimeline = buildTimelineCard(event.mode || currentMode);
  }

  const total = Number.isFinite(event.total) ? event.total : 0;
  const current = Number.isFinite(event.iteration) ? event.iteration : 0;
  const phase = typeof event.phase === 'string' ? ` ${event.phase.toUpperCase()}` : '';
  let label = `${(event.mode || currentMode).toUpperCase()}${phase}`;
  if (current > 0 && total > 0) {
    label += ` ${current}/${total}`;
  }

  if (!activeTimeline.iterLine) {
    activeTimeline.iterLine = addTimelineLine(label, 'iteration');
    return;
  }

  activeTimeline.iterLine.textContent = label;
}

function updateStatusLine(text) {
  if (!text) {
    return;
  }

  if (!activeTimeline) {
    activeTimeline = buildTimelineCard(currentMode);
  }

  if (!activeTimeline.statusLine) {
    activeTimeline.statusLine = addTimelineLine(text, 'status');
    return;
  }

  activeTimeline.statusLine.textContent = text;
}

function addToolCallLine(event) {
  const line = addTimelineLine(event.message || `Using ${event.toolName || 'tool'}`, 'tool-call');
  if (activeTimeline) {
    activeTimeline.activeToolLine = line;
  }
}

function addToolResultLine(event) {
  const ok = event.ok !== false;
  const short = (event.message || '').trim() || `${event.toolName || 'tool'} ${ok ? 'succeeded' : 'failed'}`;
  const line = addTimelineLine(short, ok ? 'tool-ok' : 'tool-error');

  const output = typeof event.output === 'string' ? event.output.trim() : '';
  if (output) {
    const detail = document.createElement('details');
    detail.className = 'tool-output';

    const summary = document.createElement('summary');
    summary.textContent = 'Output';

    const pre = document.createElement('pre');
    pre.textContent = output.length > 4000 ? `${output.slice(0, 4000)}\n\n[output truncated]` : output;

    detail.appendChild(summary);
    detail.appendChild(pre);
    line.appendChild(detail);
  }

  if (activeTimeline) {
    activeTimeline.activeToolLine = null;
  }
}

function renderAgentEvent(event) {
  if (!event || typeof event !== 'object') {
    return;
  }

  if (event.type === 'fix_iteration' || event.type === 'build_iteration') {
    updateIterationLine(event);
    return;
  }

  if (event.type === 'status') {
    updateStatusLine(event.message || 'Working...');
    return;
  }

  if (event.type === 'thinking') {
    if (event.message) {
      addTimelineLine(event.message, 'thinking');
    }
    return;
  }

  if (event.type === 'tool_call') {
    addToolCallLine(event);
    return;
  }

  if (event.type === 'tool_result') {
    addToolResultLine(event);
    return;
  }

  if (event.type === 'fix_diagnosis' || event.type === 'build_plan') {
    if (event.message) {
      addTimelineLine(event.message, 'analysis');
    }
    return;
  }

  if (event.type === 'error') {
    addTimelineLine(event.message || 'Error', 'tool-error');
    return;
  }

  if (event.type === 'fix_complete' || event.type === 'build_complete') {
    addTimelineLine(event.message || 'Complete', 'complete');
  }
}

function formatDate(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
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
  if (pendingModeSuggestion) {
    return;
  }

  const text = input.value.trim();
  if (!text) {
    return;
  }

  addMessage('user', text);
  vscode.postMessage({ type: 'chat', text, mode: currentMode });
  input.value = '';
};

for (const button of modeButtons) {
  button.addEventListener('click', () => {
    setActiveMode(button.dataset.mode || 'chat');

    if (pendingModeSuggestion) {
      const accepted = currentMode === pendingModeSuggestion.suggestedMode;
      clearModeSuggestion({ notify: true, accepted, selectedMode: currentMode });
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
  const insideHistoryBtn = historyToggle.contains(target);
  if (!insideHistory && !insideHistoryBtn) {
    setHistoryOpen(false);
  }
});

provider.addEventListener('change', () => {
  vscode.postMessage({ type: 'setProvider', provider: provider.value });
});

model.addEventListener('change', () => {
  vscode.postMessage({ type: 'setModel', model: model.value });
});

input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send.click();
  }
});

window.addEventListener('message', event => {
  const msg = event.data;

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

  if (msg.type === 'chatStart') {
    clearModeSuggestion();
    setTyping(true);
    activeTimeline = null;
    return;
  }

  if (msg.type === 'chatEnd') {
    setTyping(false);
    activeTimeline = null;
    return;
  }

  if (msg.type === 'agentEvent') {
    renderAgentEvent(msg.event);
    return;
  }

  if (msg.type === 'modeSuggestion') {
    showModeSuggestion(msg);
    return;
  }

  if (msg.type === 'switchMode') {
    setActiveMode(String(msg.mode || 'chat'));
    return;
  }

  if (msg.type === 'modeSuggestionResolved') {
    if (pendingModeSuggestion && msg.suggestionId === pendingModeSuggestion.id) {
      clearModeSuggestion();
    }
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
setActiveMode(currentMode);
