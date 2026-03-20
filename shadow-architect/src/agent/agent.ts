import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createProvider, type ChatMessage } from '../provider';
import {
  ToolExecutor,
  type ToolAccess,
  type ToolCall,
  type ToolName,
  type ToolResult
} from './tools';

export type AgentMode = 'chat' | 'fix' | 'build';

export type AgentEventType =
  | 'status'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'fix_iteration'
  | 'fix_diagnosis'
  | 'fix_complete'
  | 'build_plan'
  | 'build_iteration'
  | 'build_complete';

export interface AgentEvent {
  type: AgentEventType;
  mode: AgentMode;
  phase?: 'diagnose' | 'execute' | 'plan';
  iteration?: number;
  total?: number;
  message?: string;
  toolName?: ToolName;
  toolInput?: Record<string, unknown>;
  ok?: boolean;
  output?: string;
}

type AgentEventCallback = (event: AgentEvent) => void;

export interface AgentRunInput {
  mode: AgentMode;
  userText: string;
  history?: Array<{
    role: 'user' | 'assistant';
    text: string;
  }>;
  onEvent?: AgentEventCallback;
}

interface AgentReply {
  thought: string;
  toolCalls: ToolCall[];
  finalAnswer: string | null;
}

interface AgentReplyParseResult {
  reply: AgentReply | null;
  reason?: string;
}

interface ToolCallParseResult {
  toolCalls: ToolCall[] | null;
  reason?: string;
}

interface BuildPlanStep {
  title: string;
  description: string;
}

interface BuildPlan {
  summary: string;
  steps: BuildPlanStep[];
}

const READ_ONLY_TOOLS: ToolName[] = ['read_file', 'list_files', 'search_files'];
const ALL_TOOLS: ToolName[] = ['read_file', 'write_file', 'list_files', 'search_files', 'run_command'];

const CHAT_SYSTEM_PROMPT = [
  'You are Shadow Architect.',
  'Answer clearly and directly.',
  'Use prior conversation messages to keep context and continuity.',
  'Do not invent file contents or command outputs.'
].join(' ');

const CHAT_HISTORY_LIMIT = 20;

const FIX_DIAGNOSE_SYSTEM_PROMPT = [
  'You are in FIX mode diagnosis phase.',
  'Only diagnose root cause using read-only tools.',
  `Allowed tools: ${READ_ONLY_TOOLS.join(', ')}.`,
  'Return JSON only with keys: thought, tool_calls, final_answer.',
  'Do not wrap JSON in markdown fences or add extra prose.',
  'Always include tool_calls (use [] when no tools are needed).',
  'thought must be a concise reasoning line for UI display.',
  'tool_calls must be an array of tool actions.',
  'final_answer must be null until diagnosis is complete.',
  'When diagnosis is complete set tool_calls to [] and provide final_answer.'
].join(' ');

const FIX_EXECUTE_SYSTEM_PROMPT = [
  'You are in FIX mode execution phase.',
  'Apply the smallest fix that resolves the diagnosed issue.',
  `Allowed tools: ${ALL_TOOLS.join(', ')}.`,
  'Return JSON only with keys: thought, tool_calls, final_answer.',
  'Do not wrap JSON in markdown fences or add extra prose.',
  'Always include tool_calls (use [] when no tools are needed).',
  'Use run_command for verification when possible.',
  'When fix is complete set tool_calls to [] and provide final_answer.'
].join(' ');

const BUILD_PLAN_SYSTEM_PROMPT = [
  'You are in BUILD mode planning phase.',
  'Return JSON only with keys: summary, steps.',
  'Do not wrap JSON in markdown fences or add extra prose.',
  'steps must contain 3 to 7 items.',
  'Each item must include title and description.',
  'Do not include server start steps.'
].join(' ');

const BUILD_EXECUTE_SYSTEM_PROMPT = [
  'You are in BUILD mode execution phase.',
  'Implement the approved plan step by step.',
  `Allowed tools: ${ALL_TOOLS.join(', ')}.`,
  'Return JSON only with keys: thought, tool_calls, final_answer.',
  'Do not wrap JSON in markdown fences or add extra prose.',
  'Always include tool_calls (use [] when no tools are needed).',
  'Use concise thought text suitable for UI progress.',
  'When feature implementation is complete set tool_calls to [] and provide final_answer.'
].join(' ');

const FIX_DIAGNOSE_MAX_STEPS = 5;
const FIX_EXECUTE_MAX_STEPS = 30;
const BUILD_EXECUTE_MAX_STEPS = 50;

function appendPromptSection(base: string, extra: string): string {
  const trimmedExtra = extra.trim();
  if (!trimmedExtra) {
    return base;
  }

  return `${base}\n\n${trimmedExtra}`;
}

export class Agent {
  constructor(private readonly tools: ToolExecutor) {}

  async run(input: AgentRunInput): Promise<string> {
    const userText = input.userText.trim();
    if (!userText) {
      return '';
    }

    if (input.mode === 'chat') {
      return this.runChat(userText, input.history ?? []);
    }

    if (input.mode === 'fix') {
      return this.runFix(userText, input.onEvent);
    }

    return this.runBuild(userText, input.onEvent);
  }

  private async runChat(
    userText: string,
    history: Array<{ role: 'user' | 'assistant'; text: string }>
  ): Promise<string> {
    const provider = createProvider();
    const zeroTrustPrompt = await this.tools.buildZeroTrustPrompt();

    const historyMessages: ChatMessage[] = history
      .filter(item => item && typeof item.text === 'string' && item.text.trim().length > 0)
      .slice(-CHAT_HISTORY_LIMIT)
      .map(item => ({
        role: item.role,
        content: item.text
      }));

    return provider.chat([
      { role: 'system', content: appendPromptSection(CHAT_SYSTEM_PROMPT, zeroTrustPrompt) },
      ...historyMessages,
      { role: 'user', content: userText }
    ]);
  }

  private async runFix(userText: string, onEvent?: AgentEventCallback): Promise<string> {
    const zeroTrustPrompt = await this.tools.buildZeroTrustPrompt();

    this.emit(onEvent, {
      type: 'status',
      mode: 'fix',
      phase: 'diagnose',
      message: 'Starting diagnosis phase'
    });

    const diagnoseSummary = await this.runToolLoop({
      mode: 'fix',
      phase: 'diagnose',
      userText,
      systemPrompt: appendPromptSection(FIX_DIAGNOSE_SYSTEM_PROMPT, zeroTrustPrompt),
      access: 'read_only',
      maxSteps: FIX_DIAGNOSE_MAX_STEPS,
      iterationEventType: 'fix_iteration',
      onEvent
    });

    const diagnosisText = diagnoseSummary.finalAnswer
      ?? diagnoseSummary.lastText
      ?? 'No diagnosis summary was produced.';

    this.emit(onEvent, {
      type: 'fix_diagnosis',
      mode: 'fix',
      phase: 'diagnose',
      message: diagnosisText
    });

    const testCommand = await this.detectTestCommand();
    const executeInput = [
      `Original issue:\n${userText}`,
      `Diagnosis summary:\n${diagnosisText}`,
      `Detected test command: ${testCommand ?? 'none'}`,
      'If possible, use run_command to verify the fix before final_answer.'
    ].join('\n\n');

    this.emit(onEvent, {
      type: 'status',
      mode: 'fix',
      phase: 'execute',
      message: 'Starting execution phase'
    });

    const executeSummary = await this.runToolLoop({
      mode: 'fix',
      phase: 'execute',
      userText: executeInput,
      systemPrompt: appendPromptSection(FIX_EXECUTE_SYSTEM_PROMPT, zeroTrustPrompt),
      access: 'full',
      maxSteps: FIX_EXECUTE_MAX_STEPS,
      iterationEventType: 'fix_iteration',
      onEvent
    });

    this.emit(onEvent, {
      type: 'fix_complete',
      mode: 'fix',
      phase: 'execute',
      message: 'Fix mode finished'
    });

    return executeSummary.finalAnswer
      ?? executeSummary.lastText
      ?? 'Fix mode stopped before producing a final answer.';
  }

  private async runBuild(userText: string, onEvent?: AgentEventCallback): Promise<string> {
    const zeroTrustPrompt = await this.tools.buildZeroTrustPrompt();

    const plan = await this.createBuildPlan(userText, onEvent);
    const planText = this.formatBuildPlan(plan);

    this.emit(onEvent, {
      type: 'build_plan',
      mode: 'build',
      phase: 'plan',
      message: planText
    });

    this.emit(onEvent, {
      type: 'status',
      mode: 'build',
      phase: 'execute',
      message: 'Starting build execution phase'
    });

    const executionInput = [
      `Build request:\n${userText}`,
      `Execution plan:\n${planText}`,
      'Follow the plan step by step and update files incrementally.'
    ].join('\n\n');

    const buildSummary = await this.runToolLoop({
      mode: 'build',
      phase: 'execute',
      userText: executionInput,
      systemPrompt: appendPromptSection(BUILD_EXECUTE_SYSTEM_PROMPT, zeroTrustPrompt),
      access: 'full',
      maxSteps: BUILD_EXECUTE_MAX_STEPS,
      iterationEventType: 'build_iteration',
      onEvent
    });

    this.emit(onEvent, {
      type: 'build_complete',
      mode: 'build',
      phase: 'execute',
      message: 'Build mode finished'
    });

    return buildSummary.finalAnswer
      ?? buildSummary.lastText
      ?? 'Build mode stopped before producing a final answer.';
  }

  private async createBuildPlan(userText: string, onEvent?: AgentEventCallback): Promise<BuildPlan> {
    const provider = createProvider();
    const messages: ChatMessage[] = [
      { role: 'system', content: BUILD_PLAN_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          userText,
          '',
          `Workspace root: ${this.tools.getWorkspaceRoot()}`,
          'Respond with JSON only.'
        ].join('\n')
      }
    ];

    const response = await provider.chat(messages);
    const parsed = this.parseBuildPlan(response);
    if (parsed) {
      return parsed;
    }

    this.emit(onEvent, {
      type: 'error',
      mode: 'build',
      phase: 'plan',
      message: 'Failed to parse build plan JSON, using fallback plan.'
    });

    return {
      summary: 'Fallback plan generated due to invalid planner response.',
      steps: [
        { title: 'Analyze codebase', description: 'Inspect relevant files and patterns.' },
        { title: 'Implement changes', description: 'Apply the requested feature changes.' },
        { title: 'Verify changes', description: 'Run checks and summarize result.' }
      ]
    };
  }

  private formatBuildPlan(plan: BuildPlan): string {
    const steps = plan.steps
      .map((step, index) => `${index + 1}. ${step.title} - ${step.description}`)
      .join('\n');

    return [
      `Summary: ${plan.summary}`,
      'Steps:',
      steps
    ].join('\n');
  }

  private async runToolLoop(input: {
    mode: AgentMode;
    phase: 'diagnose' | 'execute' | 'plan';
    userText: string;
    systemPrompt: string;
    access: ToolAccess;
    maxSteps: number;
    iterationEventType: 'fix_iteration' | 'build_iteration';
    onEvent?: AgentEventCallback;
  }): Promise<{ finalAnswer: string | null; lastText: string }> {
    const provider = createProvider();
    const allowedTools = this.tools.listToolNames(input.access);
    const messages: ChatMessage[] = [
      { role: 'system', content: input.systemPrompt },
      {
        role: 'user',
        content: this.buildInitialUserMessage(input.userText, allowedTools)
      }
    ];

    let lastText = '';

    for (let step = 1; step <= input.maxSteps; step += 1) {
      this.emit(input.onEvent, {
        type: input.iterationEventType,
        mode: input.mode,
        phase: input.phase,
        iteration: step,
        total: input.maxSteps,
        message: `Iteration ${step}/${input.maxSteps}`
      });

      const rawReply = await provider.chat(messages);
      lastText = rawReply;

      const parseResult = this.parseAgentReply(rawReply, allowedTools);
      const parsed = parseResult.reply;
      messages.push({ role: 'assistant', content: rawReply });

      if (!parsed) {
        const reason = parseResult.reason ?? 'Response did not match required schema.';
        this.emit(input.onEvent, {
          type: 'error',
          mode: input.mode,
          phase: input.phase,
          iteration: step,
          message: `Invalid JSON response from model. ${reason} Requesting retry.`
        });

        messages.push({
          role: 'user',
          content: this.invalidResponseMessage(allowedTools, reason)
        });
        continue;
      }

      if (parsed.thought) {
        this.emit(input.onEvent, {
          type: 'thinking',
          mode: input.mode,
          phase: input.phase,
          iteration: step,
          message: parsed.thought
        });
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
          content: 'No tool_calls were provided and final_answer is null. Continue with valid JSON.'
        });
        continue;
      }

      const toolBlocks: string[] = [];
      for (const toolCall of parsed.toolCalls) {
        this.emit(input.onEvent, {
          type: 'tool_call',
          mode: input.mode,
          phase: input.phase,
          iteration: step,
          toolName: toolCall.name,
          toolInput: toolCall.input,
          message: this.describeToolCall(toolCall)
        });

        const result = await this.tools.execute(toolCall, { access: input.access });

        this.emit(input.onEvent, {
          type: 'tool_result',
          mode: input.mode,
          phase: input.phase,
          iteration: step,
          toolName: toolCall.name,
          ok: result.ok,
          message: result.ok ? `${toolCall.name} succeeded` : `${toolCall.name} failed`,
          output: result.output
        });

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
      'Response contract: JSON only, keys thought/tool_calls/final_answer.',
      'If not finished, keep final_answer null and continue via tool_calls.'
    ].join('\n');
  }

  private parseAgentReply(reply: string, allowedTools: ToolName[]): AgentReplyParseResult {
    const parsed = this.parseJsonLoose(reply);
    if (!parsed || typeof parsed !== 'object') {
      return {
        reply: null,
        reason: 'Response is not valid JSON object text.'
      };
    }

    const record = parsed as {
      thought?: unknown;
      reasoning?: unknown;
      analysis?: unknown;
      tool_calls?: unknown;
      toolCalls?: unknown;
      tools?: unknown;
      final_answer?: unknown;
      finalAnswer?: unknown;
      answer?: unknown;
    };

    const rawThought = record.thought ?? record.reasoning ?? record.analysis;
    const thought = typeof rawThought === 'string' ? rawThought.trim() : '';

    const rawFinalAnswer = record.final_answer ?? record.finalAnswer ?? record.answer;
    let finalAnswer: string | null;
    if (rawFinalAnswer === null || rawFinalAnswer === undefined) {
      finalAnswer = null;
    } else if (typeof rawFinalAnswer === 'string') {
      finalAnswer = rawFinalAnswer.trim() || null;
    } else {
      return {
        reply: null,
        reason: 'final_answer must be string or null.'
      };
    }

    const rawToolCalls = record.tool_calls ?? record.toolCalls ?? record.tools;
    const toolParse = this.parseToolCalls(rawToolCalls, allowedTools);
    if (toolParse.toolCalls === null) {
      return {
        reply: null,
        reason: toolParse.reason
      };
    }

    return {
      reply: {
        thought,
        toolCalls: toolParse.toolCalls,
        finalAnswer
      }
    };
  }

  private parseBuildPlan(reply: string): BuildPlan | null {
    const parsed = this.parseJsonLoose(reply);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const record = parsed as { summary?: unknown; steps?: unknown };
    const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
    if (!summary) {
      return null;
    }

    if (!Array.isArray(record.steps)) {
      return null;
    }

    const steps: BuildPlanStep[] = [];
    for (const item of record.steps) {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const row = item as { title?: unknown; description?: unknown };
      if (typeof row.title !== 'string' || typeof row.description !== 'string') {
        return null;
      }

      const title = row.title.trim();
      const description = row.description.trim();
      if (!title || !description) {
        return null;
      }

      steps.push({ title, description });
    }

    if (steps.length < 1) {
      return null;
    }

    return { summary, steps: steps.slice(0, 7) };
  }

  private parseJsonLoose(text: string): unknown {
    const trimmed = text.trim();
    const candidates: string[] = [];

    candidates.push(trimmed);

    const unfenced = this.stripMarkdownFence(trimmed);
    if (unfenced !== trimmed) {
      candidates.push(unfenced);
    }

    const fromBraces = this.extractFirstJsonObject(trimmed);
    if (fromBraces) {
      candidates.push(fromBraces);
    }

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }

    return null;
  }

  private parseToolCalls(rawToolCalls: unknown, allowedTools: ToolName[]): ToolCallParseResult {
    if (rawToolCalls === undefined || rawToolCalls === null) {
      return { toolCalls: [] };
    }

    const normalizedCalls = Array.isArray(rawToolCalls)
      ? rawToolCalls
      : (rawToolCalls && typeof rawToolCalls === 'object' ? [rawToolCalls] : null);

    if (!normalizedCalls) {
      return {
        toolCalls: null,
        reason: 'tool_calls must be an array or object.'
      };
    }

    const toolCalls: ToolCall[] = [];
    for (let index = 0; index < normalizedCalls.length; index += 1) {
      const item = normalizedCalls[index];
      if (!item || typeof item !== 'object') {
        return {
          toolCalls: null,
          reason: `tool_calls[${index}] must be an object.`
        };
      }

      const call = item as {
        name?: unknown;
        tool?: unknown;
        input?: unknown;
        arguments?: unknown;
        args?: unknown;
      };

      const rawName = typeof call.name === 'string'
        ? call.name
        : (typeof call.tool === 'string' ? call.tool : '');

      if (!rawName) {
        return {
          toolCalls: null,
          reason: `tool_calls[${index}].name must be a string.`
        };
      }

      const normalizedToolName = this.normalizeToolName(rawName);
      if (!normalizedToolName) {
        return {
          toolCalls: null,
          reason: `tool_calls[${index}].name "${rawName}" is unknown.`
        };
      }

      if (!allowedTools.includes(normalizedToolName)) {
        return {
          toolCalls: null,
          reason: `tool ${normalizedToolName} is not allowed in this phase.`
        };
      }

      const rawInputValue = call.input ?? call.arguments ?? call.args ?? {};
      let inputValue: Record<string, unknown>;

      if (typeof rawInputValue === 'string') {
        const parsedInput = this.parseJsonLoose(rawInputValue);
        if (!parsedInput || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) {
          return {
            toolCalls: null,
            reason: `tool_calls[${index}].input must be an object or JSON object string.`
          };
        }
        inputValue = parsedInput as Record<string, unknown>;
      } else if (typeof rawInputValue === 'object' && rawInputValue !== null && !Array.isArray(rawInputValue)) {
        inputValue = rawInputValue as Record<string, unknown>;
      } else {
        return {
          toolCalls: null,
          reason: `tool_calls[${index}].input must be an object.`
        };
      }

      toolCalls.push({
        name: normalizedToolName,
        input: inputValue as Record<string, unknown>
      });
    }

    return { toolCalls };
  }

  private normalizeToolName(name: string): ToolName | null {
    const normalized = name.trim().toLowerCase().replace(/[-\s]+/g, '_');

    if (normalized === 'read_file' || normalized === 'readfile') {
      return 'read_file';
    }

    if (normalized === 'write_file' || normalized === 'writefile') {
      return 'write_file';
    }

    if (normalized === 'list_files' || normalized === 'listfiles') {
      return 'list_files';
    }

    if (normalized === 'search_files' || normalized === 'searchfiles') {
      return 'search_files';
    }

    if (normalized === 'run_command' || normalized === 'runcommand' || normalized === 'bash' || normalized === 'shell') {
      return 'run_command';
    }

    if (normalized === 'list_dir' || normalized === 'list_directory' || normalized === 'ls') {
      return 'list_files';
    }

    if (normalized === 'search' || normalized === 'grep' || normalized === 'find_in_files') {
      return 'search_files';
    }

    if (normalized === 'read' || normalized === 'open_file' || normalized === 'cat') {
      return 'read_file';
    }

    if (normalized === 'write' || normalized === 'create_file' || normalized === 'edit_file') {
      return 'write_file';
    }

    return null;
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

  private extractFirstJsonObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }

    return null;
  }

  private invalidResponseMessage(allowedTools: ToolName[], reason?: string): string {
    return [
      'Invalid response format.',
      'Return valid JSON only with keys: thought, tool_calls, final_answer.',
      `Allowed tool names: ${allowedTools.join(', ')}`,
      'tool_calls must be an array and final_answer must be string or null.',
      reason ? `Schema error: ${reason}` : ''
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

  private describeToolCall(toolCall: ToolCall): string {
    if (toolCall.name === 'run_command') {
      const command = typeof toolCall.input.command === 'string' ? toolCall.input.command.trim() : '';
      if (command) {
        return `Run ${command.length > 96 ? `${command.slice(0, 96)}...` : command}`;
      }
      return 'Run command';
    }

    if (toolCall.name === 'write_file') {
      const target = typeof toolCall.input.path === 'string' ? toolCall.input.path : '';
      return target ? `Write ${target}` : 'Write file';
    }

    if (toolCall.name === 'read_file') {
      const target = typeof toolCall.input.path === 'string' ? toolCall.input.path : '';
      return target ? `Read ${target}` : 'Read file';
    }

    if (toolCall.name === 'list_files') {
      const target = typeof toolCall.input.path === 'string' ? toolCall.input.path : '.';
      return `List ${target}`;
    }

    if (toolCall.name === 'search_files') {
      const query = typeof toolCall.input.query === 'string' ? toolCall.input.query : '';
      return query ? `Search "${query}"` : 'Search files';
    }

    return `Use ${toolCall.name}`;
  }

  private emit(onEvent: AgentEventCallback | undefined, event: AgentEvent) {
    if (!onEvent) {
      return;
    }
    onEvent(event);
  }

  private async detectTestCommand(): Promise<string | null> {
    const root = this.tools.getWorkspaceRoot();

    if (await this.pathExists(path.join(root, 'Cargo.toml'))) {
      return 'cargo test';
    }

    const packageJsonPath = path.join(root, 'package.json');
    if (await this.pathExists(packageJsonPath)) {
      try {
        const text = await fs.readFile(packageJsonPath, 'utf8');
        const parsed = JSON.parse(text) as { scripts?: Record<string, string> };
        const testScript = parsed.scripts?.test?.trim();
        if (testScript && !/echo\s+["']?error: no test specified/i.test(testScript)) {
          return 'npm test';
        }
      } catch {
        return 'npm test';
      }
    }

    if (await this.pathExists(path.join(root, 'pyproject.toml'))) {
      return 'pytest';
    }

    if (await this.pathExists(path.join(root, 'go.mod'))) {
      return 'go test ./...';
    }

    if (await this.pathExists(path.join(root, 'Makefile'))) {
      return 'make test';
    }

    return null;
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
