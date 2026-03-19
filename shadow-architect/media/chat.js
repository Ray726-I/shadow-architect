const vscode = acquireVsCodeApi();
const messages = document.getElementById('messages');
const input = document.getElementById('input');
const send = document.getElementById('send');
const provider = document.getElementById('provider');
const model = document.getElementById('model');

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
  div.textContent = content;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

send.onclick = () => {
  const text = input.value.trim();
  if (!text) return;
  addMessage('user', text);
  vscode.postMessage({ type: 'chat', text });
  input.value = '';
};

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
  }
});

vscode.postMessage({ type: 'getProviderConfig' });
