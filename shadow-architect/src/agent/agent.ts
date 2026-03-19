import { createProvider, type ChatMessage } from '../provider';
import {
  ToolExecutor,
  type ToolAccess,
  type ToolCall,
  type ToolName,
  type ToolResult
} from './tools';

export type AgentMode = 'chat' | 'fix' | 'build';

export interface AgentRunInput {
  mode: AgentMode;
  userText: string;
}

const TOOL_NAMES: ToolName[] = ['read_file', 'write_file', 'list_files', 'search_files', 'run_command'];

const CHAT_SYSTEM_PROMPT = [
  'You are Shadow Architect.',
  'Answer clearly and directly.',
  'Do not invent file contents or command outputs.'
].join(' ');

const FIX_DIAGNOSE_SYSTEM_PROMPT = [
  'You are in FIX mode diagnosis phase.',
  'Only diagnose root cause with read-only tools.',
  `Allowed tools: ${['read_file', 'list_files', 'search_files'].join(', ')}.`,
  'Return JSON only in this exact shape:',
  '{"thought":"...","tool_calls":[{"name":"read_file","input":{"path":"src/app.ts"}}],"final_answer":null}',
  'When ready to move to execution set tool_calls to [] and fill final_answer with the diagnosis summary.'
].join(' ');

const FIX_EXECUTE_SYSTEM_PROMPT = [
  'You are in FIX mode execution phase.',
  'Apply the smallest safe fix and verify it.',
  `Allowed tools: ${TOOL_NAMES.join(', ')}.`,
  'Return JSON only in this exact shape:',
  '{"thought":"...","tool_calls":[{"name":"write_file","input":{"path":"src/app.ts","content":"..."}}],"final_answer":null}',
  'When fix is complete set tool_calls to [] and provide final_answer.',
  'Use run_command for tests/build validation when possible.'
].join(' ');

const BUILD_SYSTEM_PROMPT = [
  'You are in BUILD mode.',
  'Implement the requested feature incrementally.',
  `Allowed tools: ${TOOL_NAMES.join(', ')}.`,
  'Return JSON only in this exact shape:',
  '{"thought":"...","tool_calls":[{"name":"write_file","input":{"path":"src/app.ts","content":"..."}}],"final_answer":null}',
  'When done set tool_calls to [] and provide final_answer.'
].join(' ');

const DIAGNOSE_MAX_STEPS = 5;
const FIX_MAX_STEPS = 8;
const BUILD_MAX_STEPS = 8;

interface AgentReply {
  thought: string;
  toolCalls: ToolCall[];
  finalAnswer: string | null;
}

export class Agent {
  constructor(private readonly tools: ToolExecutor) {}

  async run(input: AgentRunInput): Promise<string> {
    const userText = input.userText.trim();
    if (!userText) {
      return '';
    }

    if (input.mode === 'chat') {
      return this.runChat(userText);
    }

    if (input.mode === 'fix') {
      return this.runFix(userText);
    }

    return this.runBuild(userText);
  }

  private async runChat(userText: string): Promise<string> {
    const provider = createProvider();
    return provider.chat([
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      { role: 'user', content: userText }
    ]);
  }

  private async runFix(userText: string): Promise<string> {
    const diagnoseSummary = await this.runToolLoop({
      userText,
      systemPrompt: FIX_DIAGNOSE_SYSTEM_PROMPT,
      access: 'read_only',
      maxSteps: DIAGNOSE_MAX_STEPS
    });

    const executeInput = [
      `Original issue:\n${userText}`,
      `Diagnosis summary:\n${diagnoseSummary.finalAnswer ?? diagnoseSummary.lastText ?? 'No diagnosis summary was produced.'}`
    ].join('\n\n');

    const executeSummary = await this.runToolLoop({
      userText: executeInput,
      systemPrompt: FIX_EXECUTE_SYSTEM_PROMPT,
      access: 'full',
      maxSteps: FIX_MAX_STEPS
    });

    if (executeSummary.finalAnswer) {
      return executeSummary.finalAnswer;
    }

    if (executeSummary.lastText) {
      return executeSummary.lastText;
    }

    return 'Fix mode stopped before producing a final answer. Try a more specific bug report.';
  }

  private async runBuild(userText: string): Promise<string> {
    const buildSummary = await this.runToolLoop({
      userText,
      systemPrompt: BUILD_SYSTEM_PROMPT,
      access: 'full',
      maxSteps: BUILD_MAX_STEPS
    });

    if (buildSummary.finalAnswer) {
      return buildSummary.finalAnswer;
    }

    if (buildSummary.lastText) {
      return buildSummary.lastText;
    }

    return 'Build mode stopped before producing a final answer.';
  }

  private async runToolLoop(input: {
    userText: string;
    systemPrompt: string;
    access: ToolAccess;
    maxSteps: number;
  }): Promise<{ finalAnswer: string | null; lastText: string }> {
    const provider = createProvider();
    const allowedTools = this.tools.listToolNames(input.access);
    const messages: ChatMessage[] = [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: this.buildInitialUserMessage(input.userText, allowedTools) }
    ];

    let lastText = '';

    for (let step = 1; step <= input.maxSteps; step += 1) {
      const rawReply = await provider.chat(messages);
      lastText = rawReply;

      const parsed = this.parseAgentReply(rawReply, allowedTools);
      messages.push({ role: 'assistant', content: rawReply });

      if (!parsed) {
        messages.push({
          role: 'user',
          content: this.invalidResponseMessage(allowedTools)
        });
        continue;
      }

      if (parsed.finalAnswer && parsed.toolCalls.length === 0) {
        return {
          finalAnswer: parsed.finalAnswer,
          lastText
        };
      }

      if (parsed.toolCalls.length === 0) {
        messages.push({
          role: 'user',
          content: 'No tool calls were provided and final_answer is null. Continue with valid JSON response.'
        });
        continue;
      }

      const toolBlocks: string[] = [];
      for (const toolCall of parsed.toolCalls) {
        const result = await this.tools.execute(toolCall, { access: input.access });
        toolBlocks.push(this.formatToolResult(toolCall, result));
      }

      messages.push({
        role: 'user',
        content: `Tool results:\n${toolBlocks.join('\n\n')}`
      });
    }

    return {
      finalAnswer: null,
      lastText
    };
  }

  private buildInitialUserMessage(userText: string, allowedTools: ToolName[]): string {
    return [
      userText,
      '',
      `Workspace root: ${this.tools.getWorkspaceRoot()}`,
      `Allowed tools right now: ${allowedTools.join(', ')}`,
      'Respond with JSON only.'
    ].join('\n');
  }

  private parseAgentReply(reply: string, allowedTools: ToolName[]): AgentReply | null {
    const cleaned = this.stripMarkdownFence(reply);
    let parsed: unknown;

    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const record = parsed as {
      thought?: unknown;
      tool_calls?: unknown;
      final_answer?: unknown;
    };

    const thought = typeof record.thought === 'string' ? record.thought : '';
    const finalAnswer = typeof record.final_answer === 'string'
      ? record.final_answer.trim() || null
      : null;

    const toolCalls = this.parseToolCalls(record.tool_calls, allowedTools);
    if (toolCalls === null) {
      return null;
    }

    return {
      thought,
      toolCalls,
      finalAnswer
    };
  }

  private parseToolCalls(rawToolCalls: unknown, allowedTools: ToolName[]): ToolCall[] | null {
    if (!Array.isArray(rawToolCalls)) {
      return null;
    }

    const toolCalls: ToolCall[] = [];

    for (const item of rawToolCalls) {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const call = item as { name?: unknown; input?: unknown };
      if (typeof call.name !== 'string') {
        return null;
      }

      if (!allowedTools.includes(call.name as ToolName)) {
        return null;
      }

      if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) {
        return null;
      }

      toolCalls.push({
        name: call.name as ToolName,
        input: call.input as Record<string, unknown>
      });
    }

    return toolCalls;
  }

  private stripMarkdownFence(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith('```')) {
      return trimmed;
    }

    const lines = trimmed.split('\n');
    if (lines.length < 3) {
      return trimmed;
    }

    if (!lines[0].startsWith('```')) {
      return trimmed;
    }

    if (!lines[lines.length - 1].startsWith('```')) {
      return trimmed;
    }

    return lines.slice(1, -1).join('\n').trim();
  }

  private invalidResponseMessage(allowedTools: ToolName[]): string {
    return [
      'Invalid response format.',
      'Return valid JSON only with keys: thought, tool_calls, final_answer.',
      `Allowed tool names: ${allowedTools.join(', ')}`,
      'tool_calls must be an array and final_answer must be string or null.'
    ].join(' ');
  }

  private formatToolResult(toolCall: ToolCall, result: ToolResult): string {
    const status = result.ok ? 'ok' : 'error';
    return [
      `Tool: ${toolCall.name}`,
      `Status: ${status}`,
      `Output:\n${result.output}`
    ].join('\n');
  }
}
