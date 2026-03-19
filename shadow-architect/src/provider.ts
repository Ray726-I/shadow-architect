import * as vscode from 'vscode';

export type ChatRole = 'system' | 'user' | 'assistant';
export type ProviderName = 'ollama' | 'openai';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatProvider {
  chat(messages: ChatMessage[]): Promise<string>;
}

const OPENAI_FALLBACK_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4.1-mini',
  'gpt-4.1',
  'o3-mini',
  'o1-mini'
];

function getConfig() {
  return vscode.workspace.getConfiguration('shadow-architect');
}

function getProviderFromConfig(): ProviderName {
  const provider = getConfig().get<string>('provider', 'ollama');
  return provider === 'openai' ? 'openai' : 'ollama';
}

function getModelFromConfig(): string {
  return getConfig().get<string>('model', 'qwen3-coder:480b-cloud');
}

function getBaseUrlFromConfig(): string {
  return getConfig().get<string>('baseUrl', '');
}

function getApiKeyFromConfig(): string {
  return getConfig().get<string>('apiKey', '');
}

function normalizeBaseRoot(url: string, fallbackRoot: string): string {
  if (!url.trim()) {
    return fallbackRoot;
  }

  const normalized = url.replace(/\/+$/, '');
  return normalized.replace(/\/v1\/chat\/completions$/, '');
}

function openAiCompletionsUrl(): string {
  const baseUrl = getBaseUrlFromConfig();
  return baseUrl || 'https://api.openai.com/v1/chat/completions';
}

function ollamaCompletionsUrl(): string {
  const baseUrl = getBaseUrlFromConfig();
  return baseUrl || 'http://127.0.0.1:11434/v1/chat/completions';
}

function openAiModelsUrl(): string {
  const root = normalizeBaseRoot(getBaseUrlFromConfig(), 'https://api.openai.com');
  return `${root}/v1/models`;
}

function ollamaTagsUrl(): string {
  const root = normalizeBaseRoot(getBaseUrlFromConfig(), 'http://127.0.0.1:11434');
  return `${root}/api/tags`;
}

export function getProviderConfig(): { provider: ProviderName; model: string } {
  return {
    provider: getProviderFromConfig(),
    model: getModelFromConfig()
  };
}

export function defaultModelForProvider(provider: ProviderName): string {
  return provider === 'openai' ? 'gpt-4o-mini' : 'qwen3-coder:480b-cloud';
}

export async function listModels(provider: ProviderName): Promise<string[]> {
  if (provider === 'openai') {
    const apiKey = getApiKeyFromConfig();
    if (!apiKey) {
      return OPENAI_FALLBACK_MODELS;
    }

    const response = await fetch(openAiModelsUrl(), {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      return OPENAI_FALLBACK_MODELS;
    }

    const data = await response.json() as {
      data?: Array<{ id?: string }>;
    };

    const modelIds = (data.data ?? [])
      .map(item => item.id?.trim() ?? '')
      .filter(Boolean)
      .filter(id => /^(gpt|o\d|o\d+-|text-embedding|omni)/.test(id));

    const unique = Array.from(new Set(modelIds)).sort((a, b) => a.localeCompare(b));
    return unique.length > 0 ? unique : OPENAI_FALLBACK_MODELS;
  }

  const response = await fetch(ollamaTagsUrl());
  if (!response.ok) {
    return [defaultModelForProvider('ollama')];
  }

  const data = await response.json() as {
    models?: Array<{ name?: string }>;
  };

  const names = (data.models ?? [])
    .map(item => item.name?.trim() ?? '')
    .filter(Boolean);

  const unique = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
  return unique.length > 0 ? unique : [defaultModelForProvider('ollama')];
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
  const provider = getProviderFromConfig();
  const model = getModelFromConfig();

  if (provider === 'openai') {
    const apiKey = getApiKeyFromConfig();
    const endpoint = openAiCompletionsUrl();
    return new OpenAIProvider(apiKey, model, endpoint);
  }

  const endpoint = ollamaCompletionsUrl();
  return new OllamaProvider(model, endpoint);
}
