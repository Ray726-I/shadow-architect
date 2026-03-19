import * as vscode from 'vscode';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatProvider {
  chat(messages: ChatMessage[]): Promise<string>;
}

class OpenAIProvider implements ChatProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly endpoint: string
  ) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Missing shadow-architect.apiKey setting for OpenAI provider');
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI request failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('OpenAI response was empty');
    }

    return text;
  }
}

class OllamaProvider implements ChatProvider {
  constructor(
    private readonly model: string,
    private readonly endpoint: string
  ) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.2,
        stream: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama request failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      message?: { content?: string };
    };

    const text = data.choices?.[0]?.message?.content?.trim() ?? data.message?.content?.trim();
    if (!text) {
      throw new Error('Ollama response was empty');
    }

    return text;
  }
}

export function createProvider(): ChatProvider {
  const config = vscode.workspace.getConfiguration('shadow-architect');
  const provider = config.get<string>('provider', 'ollama');
  const model = config.get<string>('model', 'qwen3-coder:480b-cloud');

  if (provider === 'openai') {
    const apiKey = config.get<string>('apiKey', '');
    const endpoint = config.get<string>('baseUrl', '') || 'https://api.openai.com/v1/chat/completions';
    return new OpenAIProvider(apiKey, model, endpoint);
  }

  const endpoint = config.get<string>('baseUrl', '') || 'http://127.0.0.1:11434/v1/chat/completions';
  return new OllamaProvider(model, endpoint);
}
