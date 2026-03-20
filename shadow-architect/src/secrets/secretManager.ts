import * as vscode from 'vscode';

const SECRET_TOKEN_REGEX = /\{\{SECRET:([a-zA-Z0-9_\-.]+)\}\}/g;

export class SecretManager {
  private readonly prefix: string;
  private readonly indexKey: string;

  constructor(
    private readonly storage: vscode.SecretStorage,
    projectId: string
  ) {
    this.prefix = `shadow_secret_${projectId}_`;
    this.indexKey = `${this.prefix}__index`;
  }

  async store(name: string, value: string): Promise<void> {
    this.validateName(name);
    if (!value) {
      throw new Error('Secret value cannot be empty.');
    }

    if (value.length < 4) {
      throw new Error('Secret value must be at least 4 characters for reliable redaction.');
    }

    await this.storage.store(this.key(name), value);
    await this.addToIndex(name);
  }

  async delete(name: string): Promise<void> {
    await this.storage.delete(this.key(name));
    await this.removeFromIndex(name);
  }

  async get(name: string): Promise<string | undefined> {
    return this.storage.get(this.key(name));
  }

  async listNames(): Promise<string[]> {
    const raw = await this.storage.get(this.indexKey);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map(item => item.trim());
    } catch {
      return [];
    }
  }

  async injectSecrets(content: string): Promise<string> {
    const names = this.extractTokenNames(content);
    if (names.length === 0) {
      return content;
    }

    let result = content;
    for (const name of names) {
      const value = await this.get(name);
      if (value === undefined) {
        continue;
      }

      const token = `{{SECRET:${name}}}`;
      result = result.split(token).join(value);
    }

    return result;
  }

  async scrubSecrets(content: string): Promise<string> {
    const names = await this.listNames();
    if (names.length === 0) {
      return content;
    }

    const replacements: Array<{ value: string; token: string }> = [];
    for (const name of names) {
      const value = await this.get(name);
      if (!value || value.length < 4) {
        continue;
      }

      replacements.push({ value, token: `{{SECRET:${name}}}` });
    }

    replacements.sort((a, b) => b.value.length - a.value.length);

    let result = content;
    for (const replacement of replacements) {
      result = result.split(replacement.value).join(replacement.token);
    }

    return result;
  }

  async buildSecretEnv(): Promise<Record<string, string>> {
    const names = await this.listNames();
    const env: Record<string, string> = {};

    for (const name of names) {
      const value = await this.get(name);
      if (value === undefined) {
        continue;
      }

      const envKey = `SHADOW_SECRET_${name.replace(/[-.]/g, '_').toUpperCase()}`;
      env[envKey] = value;
    }

    return env;
  }

  async buildSecretContextPrompt(): Promise<string> {
    const names = await this.listNames();
    if (names.length === 0) {
      return '';
    }

    const lines: string[] = [
      '## Available Secrets (Zero-Trust)',
      'The following secrets are available. You MUST NEVER attempt to read or guess their values.',
      'Use the {{SECRET:name}} token in file content and the corresponding environment variable in commands.',
      ''
    ];

    for (const name of names) {
      const envKey = `SHADOW_SECRET_${name.replace(/[-.]/g, '_').toUpperCase()}`;
      lines.push(`- \`{{SECRET:${name}}}\` (env: \`$${envKey}\`)`);
    }

    lines.push('');
    lines.push('When writing code that needs a secret, use the placeholder token. It will be injected at runtime.');
    lines.push('When running commands that need a secret, use the environment variable. It is injected automatically.');

    return lines.join('\n');
  }

  extractTokenNames(content: string): string[] {
    const names: string[] = [];
    const regex = new RegExp(SECRET_TOKEN_REGEX.source, 'g');

    let match: RegExpExecArray | null = regex.exec(content);
    while (match) {
      if (!names.includes(match[1])) {
        names.push(match[1]);
      }
      match = regex.exec(content);
    }

    return names;
  }

  private key(name: string): string {
    return `${this.prefix}${name}`;
  }

  private validateName(name: string): void {
    if (!/^[a-zA-Z0-9_\-.]+$/.test(name)) {
      throw new Error(
        `Invalid secret name '${name}'. Use only letters, numbers, underscores, hyphens, and dots.`
      );
    }
  }

  private async addToIndex(name: string): Promise<void> {
    const names = await this.listNames();
    if (names.includes(name)) {
      return;
    }

    names.push(name);
    await this.storage.store(this.indexKey, JSON.stringify(names));
  }

  private async removeFromIndex(name: string): Promise<void> {
    const names = await this.listNames();
    const filtered = names.filter(item => item !== name);
    await this.storage.store(this.indexKey, JSON.stringify(filtered));
  }
}
