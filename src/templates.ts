import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface PromptTemplate {
  name: string;
  text: string;
  updatedAt: string;
}

const MAX_NAME_UNITS = 80;
const MAX_TEXT_CHARS = 16_000;

function validateTemplateName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /[\u0000-\u001f\u007f\u2028\u2029]/.test(trimmed) || trimmed.length > MAX_NAME_UNITS) {
    throw new Error('Template name must be 1–80 single-line printable characters.');
  }
  return trimmed;
}

/** Workspace-scoped prompt template store saved locally under XDG state with 0700/0600 permissions. */
export class PromptTemplatesStore {
  private readonly directory: string;
  private readonly filePath: string;

  constructor(cwd: string, stateDirectory?: string) {
    const xdgState = process.env.XDG_STATE_HOME;
    this.directory = resolve(stateDirectory ?? join(
      xdgState && isAbsolute(xdgState) ? xdgState : join(homedir(), '.local', 'state'),
      'agy-tern',
      'templates',
    ));
    const key = createHash('sha256').update(resolve(cwd)).digest('hex');
    this.filePath = join(this.directory, `${key}.json`);
  }

  async list(): Promise<PromptTemplate[]> {
    let contents: Buffer;
    try {
      contents = await readFile(this.filePath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents);
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      const rows: PromptTemplate[] = [];
      for (const item of parsed) {
        if (typeof item !== 'object' || item === null) continue;
        const rec = item as Record<string, unknown>;
        if (typeof rec.name === 'string' && typeof rec.text === 'string' && typeof rec.updatedAt === 'string') {
          rows.push({ name: rec.name, text: rec.text, updatedAt: rec.updatedAt });
        }
      }
      return rows;
    } catch {
      return [];
    }
  }

  private async writeAll(rows: readonly PromptTemplate[]): Promise<PromptTemplate[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(rows, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    return [...rows];
  }

  async save(name: string, text: string): Promise<PromptTemplate[]> {
    const cleanName = validateTemplateName(name);
    if (!text.trim() || text.length > MAX_TEXT_CHARS) {
      throw new Error('Template text must be non-empty and at most 16,000 characters.');
    }
    const existing = await this.list();
    const updatedAt = new Date().toISOString();
    const next = [
      { name: cleanName, text, updatedAt },
      ...existing.filter(row => row.name !== cleanName),
    ];
    return this.writeAll(next);
  }

  async remove(name: string): Promise<PromptTemplate[]> {
    const existing = await this.list();
    const next = existing.filter(row => row.name !== name);
    return this.writeAll(next);
  }
}
