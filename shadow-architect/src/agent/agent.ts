import { createProvider, type ChatMessage } from '../provider';
import { ToolExecutor, type ToolCall } from './tools';

export type AgentMode = 'chat' | 'fix' | 'build';

export interface AgentRunInput {
  mode: AgentMode;
  userText: string;
}

export class Agent {
  constructor(private readonly tools: ToolExecutor) {}

  async run(input: AgentRunInput): Promise<string> {
    const text = input.userText.trim();
    if (!text) {
      return '';
    }

    if (input.mode === 'chat') {
      return this.chatOnce(text);
    }

    const toolInfo = this.tools.listToolNames().join(', ');
    const systemPrompt = input.mode === 'fix'
      ? 'You are in FIX mode. Diagnose and propose concrete fixes. Use tools when needed.'
      : 'You are in BUILD mode. Propose and implement a small feature incrementally. Use tools when needed.';

    const messages: ChatMessage[] = [
      { role: 'system', content: `${systemPrompt} Available tools: ${toolInfo}` },
      { role: 'user', content: text }
    ];

    const provider = createProvider();
    let lastReply = '';

    for (let i = 0; i < 3; i += 1) {
      const reply = await provider.chat(messages);
      lastReply = reply;
      messages.push({ role: 'assistant', content: reply });

      const toolCalls = this.extractToolCalls(reply);
      if (toolCalls.length === 0) {
        break;
      }

      for (const toolCall of toolCalls) {
        const result = await this.tools.execute(toolCall);
        messages.push({
          role: 'user',
          content: `Tool ${toolCall.name} result:\n${result.output}`
        });
      }
    }

    return lastReply;
  }

  private async chatOnce(text: string): Promise<string> {
    const provider = createProvider();
    return provider.chat([{ role: 'user', content: text }]);
  }

  private extractToolCalls(reply: string): ToolCall[] {
    const trimmed = reply.trim();
    const start = trimmed.indexOf('```json');
    const end = trimmed.lastIndexOf('```');
    if (start === -1 || end === -1 || end <= start) {
      return [];
    }

    const jsonText = trimmed.slice(start + 7, end).trim();
    try {
      const parsed = JSON.parse(jsonText) as { tool_calls?: Array<{ name?: string; input?: Record<string, unknown> }> };
      const calls = parsed.tool_calls ?? [];
      return calls
        .filter(item => typeof item.name === 'string' && item.name.length > 0)
        .map(item => ({
          name: item.name as ToolCall['name'],
          input: item.input ?? {}
        }));
    } catch {
      return [];
    }
  }
}
