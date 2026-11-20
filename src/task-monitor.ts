import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolStep } from './model';
import { compactToolHeaderText, summarizeToolCall } from './ui-format';

const execFileAsync = promisify(execFile);

export interface LiveProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
  elapsed: string;
  commandLine: string;
  summary: string;
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
  const queue: number[] = [rootPid];
  while (queue.length) {
    const parentPid = queue.shift()!;
    for (const child of byParent.get(parentPid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
      descendants.push({
        pid: child.pid,
        ppid: child.ppid,
        pgid: child.pgid,
        stat: child.stat,
        elapsed: child.elapsed,
        commandLine: child.commandLine,
        summary: summarizeProcessCommand(child.commandLine),
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

/** Correlate a recorded execute tool step with a live child OS process by command text overlap. */
export function matchToolStepToLiveProcess(
  step: ToolStep,
  processes: readonly LiveProcessInfo[],
  cwd: string,
): LiveProcessInfo | undefined {
  if (!processes.length) return undefined;
  const summary = summarizeToolCall(step.call, cwd, { includeDiffStats: false });
  const rawCmd = (summary.fullCommand ?? summary.target ?? '').trim();
  if (!rawCmd || rawCmd.length < 2) return undefined;
  const normalizedCmd = rawCmd.replace(/\s+/g, ' ').toLowerCase();
  return processes.find(proc => {
    const procNorm = proc.commandLine.replace(/\s+/g, ' ').toLowerCase();
    const sumNorm = proc.summary.toLowerCase();
    return procNorm.includes(normalizedCmd) || sumNorm.includes(normalizedCmd) || normalizedCmd.includes(sumNorm);
  });
}

/** Correlate a live OS process back to its latest matching ACP `ToolStep` for live output viewing. */
export function matchLiveProcessToToolStep(
  proc: LiveProcessInfo,
  steps: readonly ToolStep[],
  cwd: string,
): ToolStep | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (matchToolStepToLiveProcess(step, [proc], cwd)) return step;
  }
  return undefined;
}
