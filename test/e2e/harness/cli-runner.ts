import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

export interface IsolatedEnvOptions {
  /** Prefix for mkdtemp directory inside os.tmpdir(). Default: 'agy-e2e-' */
  readonly prefix?: string;
  /** Optional relative file paths -> contents to seed inside the isolated workspace. */
  readonly seedFiles?: Readonly<Record<string, string | Uint8Array>>;
  /** Explicit environment overrides applied after sanitization. Undefined deletes the key. */
  readonly envOverrides?: Readonly<Record<string, string | undefined>>;
}

export interface IsolatedEnv {
  readonly root: string;
  readonly workspace: string;
  /** Alias for workspace. */
  readonly cwd: string;
  readonly home: string;
  readonly xdgStateHome: string;
  readonly xdgConfigHome: string;
  readonly xdgDataHome: string;
  readonly xdgCacheHome: string;
  readonly logsDir: string;
  readonly env: Record<string, string>;
  cleanup(): Promise<void>;
}

export interface RunCliOptions {
  readonly cwd?: string;
  readonly isolatedEnv?: IsolatedEnv;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly executable?: string;
  readonly cliEntry?: string;
}

export interface RunCliResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallMs: number;
  readonly timedOut: boolean;
}

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const DEFAULT_CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.tsx');

const STRIPPED_ENV_KEYS = [
  'TERN_TSP',
  'TERN_TSP_RECORD',
  'STY',
  'ZELLIJ',
  'ZELLIJ_SESSION_NAME',
  'TMUX',
  'TMUX_PANE',
] as const;

export function buildSanitizedEnv(
  base: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
  overrides?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const key of STRIPPED_ENV_KEYS) {
    delete env[key];
  }
  if (!env['TERM']) env['TERM'] = 'xterm-256color';
  if (!env['COLORTERM']) env['COLORTERM'] = 'truecolor';
  if (!env['LANG']) env['LANG'] = 'C.UTF-8';
  const bunBinDir = dirname(process.execPath);
  if (!env['PATH']) {
    env['PATH'] = bunBinDir;
  } else if (!env['PATH'].split(':').includes(bunBinDir)) {
    env['PATH'] = `${bunBinDir}:${env['PATH']}`;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

export async function createIsolatedEnv(opts?: IsolatedEnvOptions): Promise<IsolatedEnv> {
  const root = await mkdtemp(join(tmpdir(), opts?.prefix ?? 'agy-e2e-'));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const xdgStateHome = join(root, 'xdg-state');
  const xdgConfigHome = join(root, 'xdg-config');
  const xdgDataHome = join(root, 'xdg-data');
  const xdgCacheHome = join(root, 'xdg-cache');
  const logsDir = join(root, 'logs');

  await Promise.all([
    mkdir(workspace, { mode: 0o700 }),
    mkdir(home, { mode: 0o700 }),
    mkdir(xdgStateHome, { mode: 0o700 }),
    mkdir(xdgConfigHome, { mode: 0o700 }),
    mkdir(xdgDataHome, { mode: 0o700 }),
    mkdir(xdgCacheHome, { mode: 0o700 }),
    mkdir(logsDir, { mode: 0o700 }),
  ]);

  const env = buildSanitizedEnv(process.env, {
    HOME: home,
    XDG_STATE_HOME: xdgStateHome,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
    XDG_CACHE_HOME: xdgCacheHome,
    ...opts?.envOverrides,
  });

  if (opts?.seedFiles) {
    const resolvedWorkspace = resolve(workspace);
    for (const [relPath, content] of Object.entries(opts.seedFiles)) {
      const target = resolve(resolvedWorkspace, relPath);
      if (target !== resolvedWorkspace && !target.startsWith(`${resolvedWorkspace}${sep}`)) {
        throw new Error(`seedFiles path escapes isolated workspace: ${relPath}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }

  return {
    root,
    workspace,
    cwd: workspace,
    home,
    xdgStateHome,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    logsDir,
    env,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function runCli(args: readonly string[], opts?: RunCliOptions): Promise<RunCliResult> {
  const cwd = opts?.cwd ?? opts?.isolatedEnv?.workspace ?? REPO_ROOT;
  const baseEnv = opts?.isolatedEnv ? opts.isolatedEnv.env : buildSanitizedEnv(process.env);
  const env = buildSanitizedEnv(baseEnv, opts?.env);
  const executable = opts?.executable ?? process.execPath;
  const cliEntry = opts?.cliEntry ? resolve(REPO_ROOT, opts.cliEntry) : DEFAULT_CLI_ENTRY;
  const timeoutMs = opts?.timeoutMs ?? 15_000;

  const t0 = performance.now();
  const child = spawn(executable, ['run', cliEntry, ...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  child.stdin?.on('error', () => {});

  if (opts?.stdin !== undefined) {
    child.stdin?.end(opts.stdin);
  } else {
    child.stdin?.end();
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const signalGroup = (sig: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      if (process.platform !== 'win32') {
        process.kill(-child.pid, sig);
      } else {
        child.kill(sig);
      }
    } catch {
      // Process or process group already exited.
    }
  };

  return await new Promise<RunCliResult>((resolvePromise, rejectPromise) => {
    const clearTimers = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };

    timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 1_000);
    }, timeoutMs);

    child.once('error', (err) => {
      clearTimers();
      rejectPromise(err);
    });

    child.once('close', (code, signal) => {
      clearTimers();
      resolvePromise({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        wallMs: Math.round(performance.now() - t0),
        timedOut,
      });
    });
  });
}
