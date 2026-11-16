import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

function normalizeName(name: string): string {
  if (!name.isWellFormed() || /[\p{Cc}\u2028\u2029]/u.test(name)) {
    throw new Error('Session names must be a single line without control characters');
  }
  const trimmed = name.trim();
  if (trimmed.length > 160) throw new Error('Session names must be at most 160 UTF-16 units');
  return trimmed;
}

// Frontend labels only; this never renames a session on the ACP server.
export class SessionNames {
  private readonly cwd: string;
  private readonly directory: string;

  constructor(cwd: string, stateDirectory?: string) {
    this.cwd = resolve(cwd);
    const xdgState = process.env.XDG_STATE_HOME;
    this.directory = resolve(stateDirectory ?? join(
      xdgState && isAbsolute(xdgState) ? xdgState : join(homedir(), '.local', 'state'),
      'agy-tern', 'session-names',
    ));
  }

  private filename(sessionId: string): string {
    const hash = createHash('sha256').update(JSON.stringify([this.cwd, sessionId])).digest('hex');
    return join(this.directory, `${hash}.txt`);
  }

  async get(sessionId: string): Promise<string | undefined> {
    let contents: Buffer;
    try {
      contents = await readFile(this.filename(sessionId));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents);
    const normalized = normalizeName(name);
    if (!normalized || name !== normalized) throw new Error('Stored session name is empty or untrimmed');
    return name;
  }

  async set(sessionId: string, name: string): Promise<void> {
    name = normalizeName(name);
    const filename = this.filename(sessionId);
    if (!name) {
      try {
        await unlink(filename);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      return;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.chmod(0o600);
        await file.writeFile(name, 'utf8');
      } finally {
        await file.close();
      }
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
