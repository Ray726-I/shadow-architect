const vscode = acquireVsCodeApi();
const messages = document.getElementById('messages');
const input = document.getElementById('input');
const send = document.getElementById('send');

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
  }
});
