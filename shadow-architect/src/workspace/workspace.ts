import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { exec as execCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const exec = promisify(execCallback);

export interface SessionMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatSession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
}

export interface SessionSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface RegisteredProject {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastUsedAt: string;
}

interface RegistryFile {
  projects: RegisteredProject[];
}

export class ShadowWorkspace {
  private readonly storagePath: string;
  private readonly workspacePath: string;
  private projectIdPromise: Promise<string> | null = null;

  constructor(storagePath: string, workspacePath: string) {
    this.storagePath = storagePath;
    this.workspacePath = path.resolve(workspacePath);
  }

  async isRegistered(): Promise<boolean> {
    const registry = await this.readRegistry();
    const projectId = await this.getProjectId();
    return registry.projects.some(item => item.id === projectId);
  }

  async registerProject(name: string): Promise<RegisteredProject> {
    const registry = await this.readRegistry();
    const projectId = await this.getProjectId();
    const now = new Date().toISOString();
    const normalizedName = name.trim() || path.basename(this.workspacePath) || 'Shadow Project';

    const existing = registry.projects.find(item => item.id === projectId);
    if (existing) {
      existing.name = normalizedName;
      existing.path = this.workspacePath;
      existing.lastUsedAt = now;
      await this.writeRegistry(registry);
      return existing;
    }

    const project: RegisteredProject = {
      id: projectId,
      name: normalizedName,
      path: this.workspacePath,
      createdAt: now,
      lastUsedAt: now
    };

    registry.projects.push(project);
    await this.writeRegistry(registry);
    return project;
  }

  async touchRegisteredProject(): Promise<void> {
    const registry = await this.readRegistry();
    const projectId = await this.getProjectId();
    const existing = registry.projects.find(item => item.id === projectId);
    if (!existing) {
      return;
    }

    existing.lastUsedAt = new Date().toISOString();
    await this.writeRegistry(registry);
  }

  async getProjectId(): Promise<string> {
    if (!this.projectIdPromise) {
      this.projectIdPromise = this.computeProjectId();
    }
    return this.projectIdPromise;
  }

  async getProjectDir(): Promise<string> {
    const projectId = await this.getProjectId();
    return path.join(this.storagePath, 'projects', projectId);
  }

  async saveChatSession(session: ChatSession): Promise<void> {
    const sessionsDir = await this.getSessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, `${session.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf8');
  }

  async listChatSessions(): Promise<SessionSummary[]> {
    const sessionsDir = await this.getSessionsDir();
    const entries = await this.safeReadDir(sessionsDir);
    const summaries: SessionSummary[] = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }

      const filePath = path.join(sessionsDir, entry);
      const session = await this.readSessionFile(filePath);
      if (!session) {
        continue;
      }

      summaries.push({
        id: session.id,
        name: session.name,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length
      });
    }

    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getChatSession(id: string): Promise<ChatSession | null> {
    const sessionsDir = await this.getSessionsDir();
    const filePath = path.join(sessionsDir, `${id}.json`);
    return this.readSessionFile(filePath);
  }

  async deleteChatSession(id: string): Promise<void> {
    const sessionsDir = await this.getSessionsDir();
    const filePath = path.join(sessionsDir, `${id}.json`);
    await fs.rm(filePath, { force: true });
  }

  private async getSessionsDir(): Promise<string> {
    const projectDir = await this.getProjectDir();
    return path.join(projectDir, 'sessions');
  }

  private async computeProjectId(): Promise<string> {
    const remoteUrl = await this.tryGetGitRemote();
    const source = remoteUrl || this.workspacePath;
    return createHash('sha256').update(source).digest('hex').slice(0, 16);
  }

  private async readRegistry(): Promise<RegistryFile> {
    const registryPath = this.getRegistryPath();

    try {
      const content = await fs.readFile(registryPath, 'utf8');
      const parsed = JSON.parse(content) as RegistryFile;
      if (!parsed || !Array.isArray(parsed.projects)) {
        return { projects: [] };
      }
      return {
        projects: parsed.projects.filter(item => {
          return Boolean(item && item.id && item.path && item.name && item.createdAt && item.lastUsedAt);
        })
      };
    } catch {
      return { projects: [] };
    }
  }

  private async writeRegistry(registry: RegistryFile): Promise<void> {
    await fs.mkdir(this.storagePath, { recursive: true });
    await fs.writeFile(this.getRegistryPath(), JSON.stringify(registry, null, 2), 'utf8');
  }

  private getRegistryPath(): string {
    return path.join(this.storagePath, 'registry.json');
  }

  private async tryGetGitRemote(): Promise<string | null> {
    try {
      const { stdout } = await exec('git remote get-url origin', {
        cwd: this.workspacePath,
        timeout: 5000
      });

      const remote = stdout.trim();
      return remote || null;
    } catch {
      return null;
    }
  }

  private async safeReadDir(dirPath: string): Promise<string[]> {
    try {
      return await fs.readdir(dirPath);
    } catch {
      return [];
    }
  }

  private async readSessionFile(filePath: string): Promise<ChatSession | null> {
    try {
      const text = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(text) as ChatSession;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      if (!parsed.id || !parsed.name || !parsed.createdAt || !parsed.updatedAt || !Array.isArray(parsed.messages)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}
