import { promisify } from 'node:util';
import { exec as execCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SecretManager } from '../secrets/secretManager';

const exec = promisify(execCallback);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)credentials?(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)id_rsa(\.pub)?$/i,
  /(^|\/)id_ed25519(\.pub)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)(?:secret|secrets|credential|credentials)\.[^/]+$/i,
  /(^|\/)[^/]*token[^/]*\.[^/]+$/i
];

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'list_files'
  | 'search_files'
  | 'run_command';

export type ToolAccess = 'read_only' | 'full';

export interface ToolCall {
  name: ToolName;
  input: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ExecuteOptions {
  access?: ToolAccess;
}

export class ToolExecutor {
  private secretManager?: SecretManager;

  constructor(
    private readonly workspaceRoot: string,
    secretManager?: SecretManager
  ) {
    this.secretManager = secretManager;
  }

  setSecretManager(secretManager?: SecretManager): void {
    this.secretManager = secretManager;
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  listToolNames(access: ToolAccess = 'full'): ToolName[] {
    if (access === 'read_only') {
      return ['read_file', 'list_files', 'search_files'];
    }

    return ['read_file', 'write_file', 'list_files', 'search_files', 'run_command'];
  }

  async buildZeroTrustPrompt(): Promise<string> {
    const lines = [
      'ZERO-TRUST SECRET HANDLING:',
      '- Secrets are managed via opaque tokens. NEVER read, guess, or fabricate secret values.',
      '- For file content use {{SECRET:name}} tokens.',
      '- For commands use environment variables like $SHADOW_SECRET_NAME.',
      '- NEVER echo, print, cat, or log secret values.',
      '- NEVER read or include .env, credentials, secret, token, or private-key file contents.',
      '- Tool outputs are redacted, but still avoid secret exposure attempts.'
    ];

    if (!this.secretManager) {
      return lines.join('\n');
    }

    const secretContext = await this.secretManager.buildSecretContextPrompt();
    if (!secretContext) {
      return lines.join('\n');
    }

    return `${lines.join('\n')}\n\n${secretContext}`;
  }

  async execute(call: ToolCall, options: ExecuteOptions = {}): Promise<ToolResult> {
    const access = options.access ?? 'full';
    if (access === 'read_only' && !this.listToolNames('read_only').includes(call.name)) {
      return { ok: false, output: `Tool ${call.name} is not allowed in read-only mode` };
    }

    try {
      if (call.name === 'read_file') {
        const filePath = this.resolvePath(String(call.input.path ?? ''));
        if (this.isSecretFile(filePath)) {
          return {
            ok: false,
            output: `[BLOCKED] Cannot read '${String(call.input.path ?? '')}': file matches secret pattern.`
          };
        }

        const content = await fs.readFile(filePath, 'utf8');
        const withLines = content
          .split('\n')
          .map((line, index) => `${String(index + 1).padStart(4)}: ${line}`)
          .join('\n');
        const scrubbed = await this.scrubOutput(withLines);
        return { ok: true, output: this.limitOutput(scrubbed) };
      }

      if (call.name === 'write_file') {
        const rawPath = String(call.input.path ?? '');
        if (this.isSecretFile(rawPath)) {
          return {
            ok: false,
            output: `[BLOCKED] Cannot write '${rawPath}': file matches secret pattern.`
          };
        }

        const filePath = this.resolvePath(rawPath);
        const content = String(call.input.content ?? '');
        const resolvedContent = await this.injectSecrets(content);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, resolvedContent, 'utf8');
        return { ok: true, output: `Wrote ${path.relative(this.workspaceRoot, filePath)}` };
      }

      if (call.name === 'list_files') {
        const target = this.resolvePath(String(call.input.path ?? '.'));
        const entries = await this.walk(target, 0, 3);
        const filtered = entries.filter(item => !this.isSecretFile(item));
        const output = filtered.join('\n') || '(empty directory)';
        return { ok: true, output: this.limitOutput(output) };
      }

      if (call.name === 'search_files') {
        const query = String(call.input.query ?? '').trim();
        if (!query) {
          return { ok: false, output: 'Missing search query' };
        }

        const entries = await this.walk(this.workspaceRoot, 0, 5);
        const files = entries.filter(item => !item.endsWith('/')).slice(0, 200);
        const hits: string[] = [];

        for (const relativePath of files) {
          if (this.isSecretFile(relativePath)) {
            continue;
          }

          const filePath = path.join(this.workspaceRoot, relativePath);
          try {
            const stat = await fs.stat(filePath);
            if (stat.size > 400_000) {
              continue;
            }

            const content = await fs.readFile(filePath, 'utf8');
            if (content.toLowerCase().includes(query.toLowerCase())) {
              hits.push(relativePath);
              if (hits.length >= 80) {
                break;
              }
            }
          } catch {
            continue;
          }
        }

        return { ok: true, output: this.limitOutput(hits.join('\n') || 'No matches') };
      }

      if (call.name === 'run_command') {
        const command = String(call.input.command ?? '').trim();
        if (!command) {
          return { ok: false, output: 'Missing command' };
        }

        if (this.isBlockedCommand(command)) {
          return {
            ok: false,
            output: '[BLOCKED] Command appears to access secrets/environment variables.'
          };
        }

        const resolvedCommand = await this.injectSecrets(command);
        const secretEnv = this.secretManager ? await this.secretManager.buildSecretEnv() : {};

        const { stdout, stderr } = await exec(resolvedCommand, {
          cwd: this.workspaceRoot,
          timeout: 120000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            ...secretEnv
          }
        });

        const rawOutput = `${stdout}${stderr}`.trim() || 'Command finished';
        const scrubbed = await this.scrubOutput(rawOutput);
        return { ok: true, output: this.limitOutput(scrubbed) };
      }

      return { ok: false, output: `Unknown tool: ${call.name}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool failed';
      const scrubbed = await this.scrubOutput(message);
      return { ok: false, output: scrubbed };
    }
  }

  private resolvePath(inputPath: string): string {
    const target = inputPath.trim() || '.';
    const absolute = path.resolve(this.workspaceRoot, target);
    const relative = path.relative(this.workspaceRoot, absolute);
    const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (!inside) {
      throw new Error('Path must stay inside workspace');
    }
    return absolute;
  }

  private async walk(targetPath: string, depth: number, maxDepth: number): Promise<string[]> {
    if (depth > maxDepth) {
      return [];
    }

    const output: string[] = [];
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(targetPath, entry.name);
      const relativePath = path.relative(this.workspaceRoot, fullPath);
      if (entry.isDirectory()) {
        output.push(`${relativePath}/`);
        const nested = await this.walk(fullPath, depth + 1, maxDepth);
        output.push(...nested);
      } else {
        output.push(relativePath);
      }
    }

    return output;
  }

  private limitOutput(text: string): string {
    const normalized = text.trim();
    if (!normalized) {
      return '(empty)';
    }

    const maxChars = 12_000;
    if (normalized.length <= maxChars) {
      return normalized;
    }

    return `${normalized.slice(0, maxChars)}\n\n[output truncated]`;
  }

  private isSecretFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    return SECRET_FILE_PATTERNS.some(pattern => pattern.test(normalized));
  }

  private isBlockedCommand(command: string): boolean {
    const lower = command.toLowerCase();

    const directBlocks = [
      /\bprintenv\b/i,
      /\benv\b/i,
      /\bset\b/i,
      /\b(cat|less|more|head|tail|sed|awk|grep|rg)\b[^\n]*\.env/i,
      /\bls\b[^\n]*\.env/i,
      /process\.env/i,
      /\becho\b[^\n]*\$shadow_secret_/i,
      /\bripgrep\b[^\n]*(api[_-]?key|token|password|secret)/i,
      /\brg\b[^\n]*(api[_-]?key|token|password|secret)/i
    ];

    if (directBlocks.some(pattern => pattern.test(lower))) {
      return true;
    }

    return lower.includes('export ') && lower.includes('key');
  }

  private redactSecrets(content: string): string {
    const patterns: Array<{ pattern: RegExp; replacement: string }> = [
      {
        pattern: /((?:aws[_-]?(?:secret[_-]?access[_-]?key|access[_-]?key[_-]?id)))\s*[=:]\s*\S+/gi,
        replacement: '$1=<REDACTED>'
      },
      {
        pattern: /((?:api[_-]?key|secret|password|token|auth|credential|private[_-]?key))\s*[=:]\s*\S+/gi,
        replacement: '$1=<REDACTED>'
      },
      {
        pattern: /((?:database[_-]?url|connection[_-]?string|redis[_-]?url|mongodb[_-]?uri))\s*[=:]\s*\S+/gi,
        replacement: '$1=<REDACTED>'
      }
    ];

    let result = content;
    for (const item of patterns) {
      result = result.replace(item.pattern, item.replacement);
    }

    return result;
  }

  private async injectSecrets(content: string): Promise<string> {
    if (!this.secretManager) {
      return content;
    }

    return this.secretManager.injectSecrets(content);
  }

  private async scrubOutput(content: string): Promise<string> {
    let result = this.redactSecrets(content);
    if (this.secretManager) {
      result = await this.secretManager.scrubSecrets(result);
    }

    return result;
  }
}
