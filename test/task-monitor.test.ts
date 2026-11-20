import { describe, expect, test } from 'bun:test';
import type { ToolStep } from '../src/model';
import {
  killLiveChildProcess,
  matchLiveProcessToToolStep,
  matchToolStepToLiveProcess,
  parseDescendantPsOutput,
} from '../src/task-monitor';

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
});
