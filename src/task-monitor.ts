import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import type { ToolStep } from './model';
import { compactToolHeaderText, extractToolLiveOutput, summarizeToolCall } from './ui-format';

const execFileAsync = promisify(execFile);

const MCP_CMD_RE = /(?:^|[\/\s"'])(?:mcp[-_]server[^\s"']*|playwright-mcp|@playwright\/mcp|duckduckgo-mcp-server|rea-agents[^\s"']*|"rea"\s+mcp|rea\s+mcp)(?:$|\s|["'@])|\buvx\s+mcp-|\bnpx\b[^\n]*\bmcp\b|\bnpm\s+exec\b[^\n]*\bmcp\b/i;
const BG_TASK_ID_RE = /background task with task id:\s*(?:[0-9a-f-]+\/)?(task-[\w-]+)/i;
const BG_LOG_URI_RE = /Task logs are available at:\s*(file:\/\/[^\s\n]+|\/[^\s\n]+\.log)/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProcessCategory = 'session' | 'mcp';

export interface LiveProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
  elapsed: string;
  commandLine: string;
  summary: string;
  category: ProcessCategory;
}

export interface BackgroundTaskRef {
  toolCallId: string;
  taskId?: string;
  logPath?: string;
  commandLabel: string;
}

interface RawPsRow {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
  elapsed: string;
  commandLine: string;
}

function summarizeProcessCommand(commandLine: string): string {
  const clean = commandLine.replace(/\s+/g, ' ').trim();
  // Unwrap POSIX login/non-login shell `-c "..."` so users see the real command first.
  const wrapped = /^(?:\/bin\/|\/usr\/bin\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+(['"]?)(.+)\1$/.exec(clean);
  const inner = wrapped?.[2]?.trim() || clean;
  return compactToolHeaderText(inner, 84);
}

/** Determine whether a command string represents an `agy`-managed MCP server helper rather than a session command. */
export function isMcpHelperCommand(commandLine: string): boolean {
  return MCP_CMD_RE.test(commandLine.replace(/\s+/g, ' ').trim());
}

/** Parse POSIX `ps -eo pid=,ppid=,pgid=,stat=,etime=,args=` output into strict descendants of `rootPid`. */
export function parseDescendantPsOutput(rawPs: string, rootPid: number): LiveProcessInfo[] {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || !rawPs.trim()) return [];
  const rows: RawPsRow[] = [];
  for (const rawLine of rawPs.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    const stat = match[4]!;
    const elapsed = match[5]!;
    const commandLine = match[6]!.trim();
    if (!Number.isInteger(pid) || pid <= 0 || !commandLine) continue;
    if (/^(?:\/bin\/|\/usr\/bin\/)?ps\s+-eo\b/.test(commandLine)) continue;
    if (stat.startsWith('Z')) continue;
    rows.push({ pid, ppid, pgid, stat, elapsed, commandLine });
  }

  const byParent = new Map<number, RawPsRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.ppid);
    if (list) list.push(row);
    else byParent.set(row.ppid, [row]);
  }

  const descendants: LiveProcessInfo[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: Array<{ pid: number; inMcpSubtree: boolean }> = [{ pid: rootPid, inMcpSubtree: false }];
  while (queue.length) {
    const { pid: parentPid, inMcpSubtree } = queue.shift()!;
    for (const child of byParent.get(parentPid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      const isMcp = inMcpSubtree || isMcpHelperCommand(child.commandLine);
      queue.push({ pid: child.pid, inMcpSubtree: isMcp });
      descendants.push({
        pid: child.pid,
        ppid: child.ppid,
        pgid: child.pgid,
        stat: child.stat,
        elapsed: child.elapsed,
        commandLine: child.commandLine,
        summary: summarizeProcessCommand(child.commandLine),
        category: isMcp ? 'mcp' : 'session',
      });
    }
  }

  return descendants.sort((a, b) => a.pid - b.pid);
}

/** List active child processes strictly descending from the spawned `agy` subprocess PID. */
export async function listLiveChildProcesses(rootPid: number | undefined): Promise<LiveProcessInfo[]> {
  if (rootPid === undefined || !Number.isInteger(rootPid) || rootPid <= 0) return [];
  if (process.platform === 'win32') return [];
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-eo', 'pid=,ppid=,pgid=,stat=,etime=,args='],
      { timeout: 1_500, maxBuffer: 512 * 1024, encoding: 'utf8' },
    );
    return parseDescendantPsOutput(stdout, rootPid);
  } catch {
    return [];
  }
}

/** Signal a single verified descendant PID (or its process group when isolated) under `rootPid`. */
export async function killLiveChildProcess(
  rootPid: number | undefined,
  targetPid: number,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
): Promise<void> {
  if (rootPid === undefined || !Number.isInteger(rootPid) || rootPid <= 0) {
    throw new Error('Antigravity subprocess is not active.');
  }
  const active = await listLiveChildProcesses(rootPid);
  const target = active.find(proc => proc.pid === targetPid);
  if (!target) {
    throw new Error(`Process ${targetPid} is no longer running under this agy session.`);
  }
  if (target.pid === rootPid) {
    throw new Error('Refusing to signal the main agy ACP subprocess directly; use Esc/Stop instead.');
  }
  try {
    if (process.platform !== 'win32' && target.pgid === target.pid && target.pgid !== process.pid) {
      process.kill(-target.pid, signal);
    } else {
      process.kill(target.pid, signal);
    }
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ESRCH') {
      throw new Error(`Process ${targetPid} already exited.`);
    }
    throw cause;
  }
}

function normalizeMatchTokens(raw: string): string[] {
  return raw
    .replace(/['"`]/g, ' ')
    .split(/\s+/)
    .map(tok => tok.trim().toLowerCase())
    .filter(tok => tok.length >= 4 && !tok.startsWith('-') && !['bash', 'true', 'false', 'echo', 'sleep'].includes(tok));
}

/** Correlate a recorded execute tool step with a live session child OS process. */
export function matchToolStepToLiveProcess(
  step: ToolStep,
  processes: readonly LiveProcessInfo[],
  cwd: string,
): LiveProcessInfo | undefined {
  const sessionProcs = processes.filter(proc => proc.category === 'session');
  if (!sessionProcs.length) return undefined;
  const summary = summarizeToolCall(step.call, cwd, { includeDiffStats: false });
  const rawCmd = (summary.fullCommand ?? summary.target ?? '').trim();
  if (!rawCmd || rawCmd.length < 2) return undefined;
  const normalizedCmd = rawCmd.replace(/\s+/g, ' ').toLowerCase();
  const exact = sessionProcs.find(proc => {
    const procNorm = proc.commandLine.replace(/\s+/g, ' ').toLowerCase();
    const sumNorm = proc.summary.toLowerCase();
    return procNorm.includes(normalizedCmd) || sumNorm.includes(normalizedCmd) || normalizedCmd.includes(sumNorm);
  });
  if (exact) return exact;
  const tokens = normalizeMatchTokens(rawCmd);
  if (!tokens.length) return undefined;
  return sessionProcs.find(proc => {
    const procLower = proc.commandLine.toLowerCase();
    return tokens.some(tok => procLower.includes(tok) || procLower.includes(basename(tok)));
  });
}

/** Correlate a live OS process back to its latest matching ACP `ToolStep` for live output viewing. */
export function matchLiveProcessToToolStep(
  proc: LiveProcessInfo,
  steps: readonly ToolStep[],
  cwd: string,
): ToolStep | undefined {
  if (proc.category === 'mcp') return undefined;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (matchToolStepToLiveProcess(step, [proc], cwd)) return step;
  }
  return undefined;
}

/** Parse official `file://...` or absolute path inside `<appDataDir>/brain/<uuid>/.system_generated/tasks/*.log`. */
export function resolveSafeTaskLogPath(rawUriOrPath: string, appDataDir?: string): string | undefined {
  let candidate = rawUriOrPath.trim();
  if (!candidate) return undefined;
  if (candidate.startsWith('file://')) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch {
      return undefined;
    }
  }
  if (!isAbsolute(candidate) || !candidate.endsWith('.log')) return undefined;
  const cleanPath = resolve(candidate);
  const brainBase = resolve(appDataDir ?? join(homedir(), '.gemini', 'antigravity-cli'), 'brain');
  if (!cleanPath.startsWith(`${brainBase}/`)) return undefined;
  const rel = cleanPath.slice(brainBase.length + 1).split('/');
  // Expect <uuid>/.system_generated/tasks/<file>.log
  if (rel.length !== 4 || !UUID_RE.test(rel[0]!) || rel[1] !== '.system_generated' || rel[2] !== 'tasks') {
    return undefined;
  }
  return cleanPath;
}

/** Detect whether a `ToolStep` launched or references an official background task log (`task-XXXX.log`). */
export function extractBackgroundTaskRef(
  step: ToolStep,
  cwd: string,
  appDataDir?: string,
): BackgroundTaskRef | undefined {
  const combined = extractToolLiveOutput(step) ?? '';
  const rawOut = typeof step.call.rawOutput === 'object' && step.call.rawOutput !== null
    ? JSON.stringify(step.call.rawOutput)
    : typeof step.call.rawOutput === 'string'
      ? step.call.rawOutput
      : '';
  const probe = `${combined}\n${rawOut}`;
  const idMatch = BG_TASK_ID_RE.exec(probe);
  const uriMatch = BG_LOG_URI_RE.exec(probe);
  const logPath = uriMatch?.[1] ? resolveSafeTaskLogPath(uriMatch[1], appDataDir) : undefined;
  if (!idMatch?.[1] && !logPath) return undefined;
  const summary = summarizeToolCall(step.call, cwd, { includeDiffStats: false });
  return {
    toolCallId: step.call.toolCallId,
    ...(idMatch?.[1] ? { taskId: idMatch[1] } : {}),
    ...(logPath ? { logPath } : {}),
    commandLabel: summary.target ?? summary.title,
  };
}

/** Read bounded live stdout/stderr tail from a verified session task log file without blocking render. */
export async function readTaskLogTail(
  logPath: string,
  maxBytes = 48 * 1024,
  appDataDir?: string,
): Promise<{ text: string; size: number; mtimeMs: number } | undefined> {
  const safePath = resolveSafeTaskLogPath(logPath, appDataDir);
  if (!safePath) return undefined;
  try {
    const file = await open(safePath, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) return undefined;
      if (info.size === 0) return { text: '', size: 0, mtimeMs: info.mtimeMs };
      const offset = Math.max(0, info.size - maxBytes);
      const length = info.size - offset;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buf, 0, length, offset);
      const text = stripVTControlCharacters(buf.subarray(0, bytesRead).toString('utf8')).trimEnd();
      return { text, size: info.size, mtimeMs: info.mtimeMs };
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/** List recent `.log` files directly under the active session's official `.system_generated/tasks/` folder. */
export async function listSessionTaskLogs(
  sessionId: string,
  limit = 12,
  appDataDir?: string,
): Promise<Array<{ taskId: string; logPath: string; size: number; mtimeMs: number }>> {
  const cleanId = sessionId.trim();
  if (!UUID_RE.test(cleanId)) return [];
  const tasksDir = join(resolve(appDataDir ?? join(homedir(), '.gemini', 'antigravity-cli')), 'brain', cleanId, '.system_generated', 'tasks');
  try {
    const names = (await readdir(tasksDir)).filter(name => name.endsWith('.log'));
    const stats = await Promise.all(names.map(async name => {
      const logPath = join(tasksDir, name);
      const info = await stat(logPath).catch(() => undefined);
      if (!info?.isFile()) return undefined;
      return {
        taskId: name.slice(0, -4),
        logPath,
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    }));
    return stats
      .filter((item): item is { taskId: string; logPath: string; size: number; mtimeMs: number } => item !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}
