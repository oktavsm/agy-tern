import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolStep } from '../src/model';
import {
  extractBackgroundTaskRef,
  killLiveChildProcess,
  listSessionTaskLogs,
  matchLiveProcessToToolStep,
  matchToolStepToLiveProcess,
  parseDescendantPsOutput,
  readTaskLogTail,
} from '../src/task-monitor';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('task-monitor live process tree helpers', () => {
  test('extracts strict descendant tree under rootPid while excluding rootPid, zombies, ps, and unrelated PIDs', () => {
    const samplePs = [
      '    1     0     1 Ss   10:00 /sbin/init',
      '  500     1   500 Ss   01:20 agy acp --sandbox',
      '  510   500   510 S+   00:15 /bin/sh -c npm run dev',
      '  511   510   510 S+   00:15 vite --port 5173',
      '  512   500   500 Z    00:00 [defunct]',
      '  513   500   513 R+   00:00 ps -eo pid=,ppid=,pgid=,stat=,etime=,args=',
      '  999     1   999 Ss   05:00 unrelated-daemon',
    ].join('\n');

    const tree = parseDescendantPsOutput(samplePs, 500);
    expect(tree.map(item => item.pid)).toEqual([510, 511]);
    expect(tree[0]?.summary).toBe('npm run dev');
    expect(tree[1]?.summary).toBe('vite --port 5173');
  });

  test('correlates execute tool steps and live processes bidirectionally and guards invalid kill targets', async () => {
    const samplePs = [
      '  500     1   500 Ss   01:20 agy acp --sandbox',
      '  620   500   620 S+   00:42 /bin/sh -c npm run dev',
    ].join('\n');
    const procs = parseDescendantPsOutput(samplePs, 500);
    const step: ToolStep = {
      type: 'tool',
      id: 'entry-1',
      call: {
        toolCallId: 'call-dev',
        kind: 'execute',
        name: 'run_command',
        title: 'npm run dev',
        status: 'in_progress',
        rawInput: { CommandLine: 'npm run dev' },
      },
    };

    expect(matchToolStepToLiveProcess(step, procs, '/tmp/app')?.pid).toBe(620);
    expect(matchLiveProcessToToolStep(procs[0]!, [step], '/tmp/app')?.id).toBe('entry-1');

    await expect(killLiveChildProcess(undefined, 620)).rejects.toThrow('not active');
    await expect(killLiveChildProcess(process.pid, 999999)).rejects.toThrow('no longer running');
  });

  test('separates agy MCP helper daemons and their descendants from session child processes', () => {
    const samplePs = [
      '  500     1   500 Ss   01:20 agy acp --sandbox',
      '  501   500   501 Sl   00:40 /opt/bin/uv tool uvx mcp-server-fetch',
      '  502   500   502 Sl   00:40 npm exec rea-agents@6.7.0 mcp',
      '  503   502   502 Sl   00:39 node /home/user/.npm/_npx/123/node_modules/.bin/rea mcp',
      '  504   503   502 S    00:39 "rea" mcp',
      '  550   500   550 S+   00:12 /bin/bash ./scripts/backup_cluster_data.sh',
    ].join('\n');

    const tree = parseDescendantPsOutput(samplePs, 500);
    const mcpProcs = tree.filter(item => item.category === 'mcp');
    const sessionProcs = tree.filter(item => item.category === 'session');
    expect(mcpProcs.map(item => item.pid)).toEqual([501, 502, 503, 504]);
    expect(sessionProcs.map(item => item.pid)).toEqual([550]);
    expect(sessionProcs[0]?.summary).toBe('/bin/bash ./scripts/backup_cluster_data.sh');
  });

  test('extracts safe session background task log paths and reads bounded tail output', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'agy-tern-tasklog-'));
    tempDirs.push(appData);
    const sessionUuid = '16653416-77b5-4a12-9012-abcdef123456';
    const tasksDir = join(appData, 'brain', sessionUuid, '.system_generated', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const logFile = join(tasksDir, 'task-9a1b.log');
    writeFileSync(logFile, '\u001b[32mStarting backup\u001b[0m\nDumping sqlite...\nUpload 100%\n', 'utf8');

    const outsideFile = join(appData, 'secret.log');
    writeFileSync(outsideFile, 'do not leak', 'utf8');

    const step: ToolStep = {
      type: 'tool',
      id: 'entry-bg',
      call: {
        toolCallId: 'call-bg-1',
        kind: 'execute',
        name: 'run_command',
        title: 'Run ./backup_cluster_data.sh',
        status: 'completed',
        rawInput: { CommandLine: './scripts/backup_cluster_data.sh' },
        rawOutput: {
          output: `Tool is running as a background task with task id: ${sessionUuid}/task-9a1b. Task logs are available at: file://${logFile}`,
        },
      },
    };

    const ref = extractBackgroundTaskRef(step, '/tmp/project', appData);
    expect(ref?.taskId).toBe('task-9a1b');
    expect(ref?.logPath).toBe(logFile);

    const tail = await readTaskLogTail(logFile, 4096, appData);
    expect(tail?.text).toContain('Starting backup');
    expect(tail?.text).toContain('Upload 100%');
    expect(await readTaskLogTail(outsideFile, 4096, appData)).toBeUndefined();

    const listed = await listSessionTaskLogs(sessionUuid, 5, appData);
    expect(listed.map(item => item.taskId)).toEqual(['task-9a1b']);
  });
});
