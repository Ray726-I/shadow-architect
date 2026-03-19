import { promisify } from 'node:util';
import { exec as execCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const exec = promisify(execCallback);

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'list_files'
  | 'search_files'
  | 'run_command';

export interface ToolCall {
  name: ToolName;
  input: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export class ToolExecutor {
  constructor(private readonly workspaceRoot: string) {}

  listToolNames(): ToolName[] {
    return ['read_file', 'write_file', 'list_files', 'search_files', 'run_command'];
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      if (call.name === 'read_file') {
        const filePath = this.resolvePath(String(call.input.path ?? ''));
        const content = await fs.readFile(filePath, 'utf8');
        return { ok: true, output: content };
      }

      if (call.name === 'write_file') {
        const filePath = this.resolvePath(String(call.input.path ?? ''));
        const content = String(call.input.content ?? '');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf8');
        return { ok: true, output: `Wrote ${filePath}` };
      }

      if (call.name === 'list_files') {
        const target = this.resolvePath(String(call.input.path ?? '.'));
        const entries = await this.walk(target, 0, 3);
        return { ok: true, output: entries.join('\n') };
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
          const filePath = path.join(this.workspaceRoot, relativePath);
          try {
            const content = await fs.readFile(filePath, 'utf8');
            if (content.toLowerCase().includes(query.toLowerCase())) {
              hits.push(relativePath);
            }
          } catch {
            continue;
          }
        }

        return { ok: true, output: hits.join('\n') || 'No matches' };
      }

      if (call.name === 'run_command') {
        const command = String(call.input.command ?? '').trim();
        if (!command) {
          return { ok: false, output: 'Missing command' };
        }
        const { stdout, stderr } = await exec(command, {
          cwd: this.workspaceRoot,
          timeout: 120000,
          maxBuffer: 1024 * 1024
        });
        return { ok: true, output: `${stdout}${stderr}`.trim() || 'Command finished' };
      }

      return { ok: false, output: `Unknown tool: ${call.name}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool failed';
      return { ok: false, output: message };
    }
  }

  private resolvePath(inputPath: string): string {
    const target = inputPath.trim() || '.';
    const absolute = path.resolve(this.workspaceRoot, target);
    if (!absolute.startsWith(this.workspaceRoot)) {
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
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') {
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
}
