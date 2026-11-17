#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type SuiteName = 'cli-startup' | 'pty-idle' | 'pty-paced-stream' | 'micro-ops' | 'omp-compare';

const ALL_SUITES: readonly SuiteName[] = [
  'cli-startup',
  'pty-idle',
  'pty-paced-stream',
  'micro-ops',
  'omp-compare',
];

interface CliStartupMetric {
  label: string;
  skipped?: boolean;
  reason?: string;
  runs: number;
  cold_ms: number | null;
  warm_median_ms: number | null;
  warm_min_ms: number | null;
  warm_max_ms: number | null;
  median_rss_mb: number | null;
  max_rss_mb: number | null;
}

interface PtyIdleResult {
  entrypoint: string;
  first_output_ms: number | null;
  first_frame_ms: number | null;
  ready_ms: number | null;
  frames: number;
  wire_bytes: number;
  steady_rss_mb: number | null;
  peak_rss_mb: number | null;
  startup_cpu_ms: number | null;
  idle_cpu_pct: number | null;
}

interface PtyPacedStreamResult {
  entrypoint: string;
  ready_ms: number | null;
  stream_wall_ms: number | null;
  frames: number;
  fps: number | null;
  wire_bytes: number;
  cpu_pct: number | null;
  peak_rss_mb: number | null;
  end_rss_mb: number | null;
  lag_p50_ms: number | null;
  lag_p95_ms: number | null;
  lag_p99_ms: number | null;
  lag_max_ms: number | null;
  lag_samples: number;
}

interface MicroOpItem {
  name: string;
  iterations: number;
  total_ms: number;
  mean_ms: number;
  skipped?: boolean;
}

interface OmpCompareResult {
  skipped: boolean;
  reason?: string;
  version?: string;
  cli?: CliStartupMetric[];
  pty_idle?: PtyIdleResult;
}

interface BenchmarkReport {
  timestamp: string;
  target: string;
  gitRef: string;
  bunVersion: string;
  suites: {
    'cli-startup'?: CliStartupMetric[];
    'pty-idle'?: PtyIdleResult;
    'pty-paced-stream'?: PtyPacedStreamResult;
    'micro-ops'?: MicroOpItem[];
    'omp-compare'?: OmpCompareResult;
  };
}

interface ParsedBenchArgs {
  baseline?: string;
  jsonOut?: string;
  suites: SuiteName[];
  runs: number;
}

function parseBenchArgs(argv: readonly string[]): ParsedBenchArgs {
  let baseline: string | undefined;
  let jsonOut: string | undefined;
  let suites: SuiteName[] = [...ALL_SUITES];
  let runs = 9;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--baseline' && argv[i + 1]) {
      baseline = argv[++i]!;
    } else if (arg.startsWith('--baseline=')) {
      baseline = arg.slice('--baseline='.length);
    } else if (arg === '--json' && argv[i + 1]) {
      jsonOut = argv[++i]!;
    } else if (arg.startsWith('--json=')) {
      jsonOut = arg.slice('--json='.length);
    } else if (arg === '--suites' && argv[i + 1]) {
      suites = parseSuitesList(argv[++i]!);
    } else if (arg.startsWith('--suites=')) {
      suites = parseSuitesList(arg.slice('--suites='.length));
    } else if (arg === '--runs' && argv[i + 1]) {
      runs = Math.max(1, Number.parseInt(argv[++i]!, 10) || 9);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun run scripts/bench.ts [--baseline <ref>] [--json <out>] [--suites <list>] [--runs <n>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { baseline, jsonOut, suites, runs };
}

function parseSuitesList(raw: string): SuiteName[] {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const out: SuiteName[] = [];
  for (const part of parts) {
    if (!ALL_SUITES.includes(part as SuiteName)) {
      throw new Error(`Unknown suite "${part}". Valid suites: ${ALL_SUITES.join(', ')}`);
    }
    if (!out.includes(part as SuiteName)) out.push(part as SuiteName);
  }
  return out.length ? out : [...ALL_SUITES];
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function measureTimedCommand(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
): { wallMs: number; rssMb: number | null } {
  const hasTime = existsSync('/usr/bin/time');
  const fullCmd = hasTime ? ['/usr/bin/time', '-v', ...cmd] : cmd;
  const started = performance.now();
  const res = spawnSync(fullCmd[0]!, fullCmd.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const wallMs = performance.now() - started;
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd.join(' ')}\nstdout:\n${res.stdout ?? ''}\nstderr:\n${res.stderr ?? ''}`);
  }
  let rssMb: number | null = null;
  if (hasTime && res.stderr) {
    const match = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(res.stderr);
    if (match) rssMb = Number(match[1]) / 1024;
  }
  return { wallMs, rssMb };
}

function measureCliStartupGroup(
  label: string,
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  warmRuns: number,
): CliStartupMetric {
  const cold = measureTimedCommand(cmd, cwd, env);
  const warmTimes: number[] = [];
  const rssSamples: number[] = cold.rssMb !== null ? [cold.rssMb] : [];

  for (let i = 0; i < warmRuns; i++) {
    const sample = measureTimedCommand(cmd, cwd, env);
    warmTimes.push(sample.wallMs);
    if (sample.rssMb !== null) rssSamples.push(sample.rssMb);
  }

  return {
    label,
    runs: 1 + warmRuns,
    cold_ms: round(cold.wallMs),
    warm_median_ms: round(median(warmTimes)),
    warm_min_ms: round(Math.min(...warmTimes)),
    warm_max_ms: round(Math.max(...warmTimes)),
    median_rss_mb: round(median(rssSamples)),
    max_rss_mb: rssSamples.length ? round(Math.max(...rssSamples)) : null,
  };
}

function makeIsolatedEnv(tmpBase: string, extra: Record<string, string> = {}): Record<string, string> {
  const homeDir = join(tmpBase, 'home');
  const configDir = join(tmpBase, 'xdg-config');
  const dataDir = join(tmpBase, 'xdg-data');
  const stateDir = join(tmpBase, 'xdg-state');
  const cacheDir = join(tmpBase, 'xdg-cache');
  for (const dir of [homeDir, configDir, dataDir, stateDir, cacheDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_STATE_HOME: stateDir,
    XDG_CACHE_HOME: cacheDir,
    TERM: 'xterm-256color',
    ...extra,
  };
}

function ensureDoctorShim(tmpBase: string): string {
  const realAgy = Bun.which('agy');
  if (realAgy) return realAgy;
  const shimPath = join(tmpBase, 'doctor-agy-shim.sh');
  writeFileSync(shimPath, '#!/usr/bin/env bash\nif [ "$1" = "help" ] && [ "$2" = "acp" ]; then echo "--sandbox --stdio"; exit 0; fi\nif [ "$1" = "--version" ]; then echo "agy-shim 1.0.0"; exit 0; fi\nexit 0\n');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

function runCliStartupSuite(targetRoot: string, tmpBase: string, warmRuns: number): CliStartupMetric[] {
  const env = makeIsolatedEnv(join(tmpBase, 'cli-env'));
  const agyBin = ensureDoctorShim(tmpBase);
  const doctorExtraArgs = agyBin === Bun.which('agy') ? [] : ['--agy', agyBin];
  const results: CliStartupMetric[] = [];

  results.push(measureCliStartupGroup('bun src/cli.tsx --help', ['bun', 'src/cli.tsx', '--help'], targetRoot, env, warmRuns));
  results.push(measureCliStartupGroup(
    'bun src/cli.tsx --doctor --json',
    ['bun', 'src/cli.tsx', '--doctor', '--json', ...doctorExtraArgs],
    targetRoot,
    env,
    warmRuns,
  ));

  const distEntry = join(targetRoot, 'dist/cli.js');
  if (existsSync(distEntry)) {
    results.push(measureCliStartupGroup('bun dist/cli.js --help', ['bun', 'dist/cli.js', '--help'], targetRoot, env, warmRuns));
    results.push(measureCliStartupGroup(
      'bun dist/cli.js --doctor --json',
      ['bun', 'dist/cli.js', '--doctor', '--json', ...doctorExtraArgs],
      targetRoot,
      env,
      warmRuns,
    ));
  } else {
    results.push({
      label: 'bun dist/cli.js --help',
      skipped: true,
      reason: 'dist/cli.js not present',
      runs: 0,
      cold_ms: null,
      warm_median_ms: null,
      warm_min_ms: null,
      warm_max_ms: null,
      median_rss_mb: null,
      max_rss_mb: null,
    });
    results.push({
      label: 'bun dist/cli.js --doctor --json',
      skipped: true,
      reason: 'dist/cli.js not present',
      runs: 0,
      cold_ms: null,
      warm_median_ms: null,
      warm_min_ms: null,
      warm_max_ms: null,
      median_rss_mb: null,
      max_rss_mb: null,
    });
  }
  return results;
}

const PYTHON_PTY_DRIVER = `#!/usr/bin/env python3
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

HELLO_REPLY = json.dumps({
    "r": "hello",
    "v": 1,
    "term": "tern",
    "ver": "0.9.26",
    "kinds": [
        "col", "row", "text", "span", "kbd", "rule", "box", "scroll",
        "md", "code", "diff", "input", "picker", "table", "tree", "chart",
        "meter", "spark", "spinner", "shimmer", "status", "bar", "seg",
        "elapsed", "tool", "trace", "thinking", "message", "composer",
        "prefs", "hovercard", "split", "badge", "button", "link", "icon",
        "image", "progress", "chip", "empty", "suggestions", "rate"
    ],
    "features": [
        "blobs", "settle", "adopt", "dock", "reduce-motion",
        "aside", "scroll", "styles", "flow", "font"
    ],
    "apc": 65536,
    "credits": 4,
    "cols": 120,
    "cell": {"w": 8, "h": 16},
    "dark": True,
    "reduceMotion": False,
    "hour12": False
})

CLK_TCK = os.sysconf(os.sysconf_names["SC_CLK_TCK"])

def read_proc_stats(pid):
    rss_kb = None
    hwm_kb = None
    cpu_sec = None
    try:
        with open(f"/proc/{pid}/status", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    rss_kb = int(line.split()[1])
                elif line.startswith("VmHWM:"):
                    hwm_kb = int(line.split()[1])
    except OSError:
        pass
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as f:
            raw = f.read()
        rparen = raw.rfind(")")
        rest = raw[rparen + 2:].split()
        utime = int(rest[11])
        stime = int(rest[12])
        cpu_sec = (utime + stime) / CLK_TCK
    except OSError:
        pass
    return rss_kb, hwm_kb, cpu_sec

def parse_tsp_frames(buf, chunk_accum):
    events = []
    pos = 0
    while True:
        da1 = buf.find(b"\\x1b[c", pos)
        start = buf.find(b"\\x1b_tsp;", pos)
        if da1 != -1 and (start == -1 or da1 < start):
            events.append(("da1", None, b""))
            pos = da1 + 3
            continue
        if start == -1:
            break
        st = buf.find(b"\\x1b\\\\", start + 6)
        if st == -1:
            break
        raw_msg = buf[start + 6:st]
        pos = st + 2
        semi = raw_msg.find(b";")
        if semi == -1:
            continue
        verb = raw_msg[:semi].decode("ascii", errors="replace")
        rest = raw_msg[semi + 1:]
        params = {}
        while True:
            eq = rest.find(b"=")
            psemi = rest.find(b";")
            if eq != -1 and psemi != -1 and eq < psemi:
                k = rest[:eq].decode("ascii", errors="replace")
                if k and all(c.isalnum() or c in "_-" for c in k):
                    v = rest[eq + 1:psemi].decode("ascii", errors="replace")
                    params[k] = v
                    rest = rest[psemi + 1:]
                    continue
            break
        cid = params.get("c")
        if cid is not None:
            prev = chunk_accum.get(cid, b"")
            combined = prev + rest
            if params.get("m") == "1":
                chunk_accum[cid] = combined
                continue
            chunk_accum.pop(cid, None)
            body = combined
        else:
            body = rest
        events.append((verb, params, body))
    if pos > 0:
        del buf[:pos]
    elif len(buf) > 4096:
        # Avoid unbounded prefix growth before first APC sequence.
        last_esc = buf.rfind(b"\\x1b")
        if last_esc > 0:
            del buf[:last_esc]
    return events

def main():
    cfg = json.loads(sys.argv[1])
    mode = cfg["mode"]
    cmd = cfg["cmd"]
    cwd = cfg["cwd"]
    timeout_s = cfg.get("timeout_s", 15.0)
    idle_window_s = cfg.get("idle_window_s", 3.0)
    ready_marker = cfg.get("ready_marker", "Ready")
    done_marker = cfg.get("done_marker", "BENCH_STREAM_DONE")

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 960, 640))

    started = time.monotonic()
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        preexec_fn=os.setsid,
    )
    os.close(slave)

    buf = bytearray()
    chunk_accum = {}
    first_output_ms = None
    first_frame_ms = None
    ready_ms = None
    stream_start_ms = None
    stream_done_ms = None
    frames = 0
    wire_bytes = 0
    peak_rss_kb = 0
    cpu_at_ready = None
    cpu_at_end = None
    steady_rss_kb = None
    idle_start_t = None
    idle_start_cpu = None
    done = False

    def write_master(data_bytes):
        os.write(master, data_bytes)

    try:
        while not done:
            now = time.monotonic()
            elapsed = now - started
            if elapsed > timeout_s:
                break

            rlist, _, _ = select.select([master], [], [], 0.05)
            if master in rlist:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                now = time.monotonic()
                wire_bytes += len(chunk)
                if first_output_ms is None:
                    first_output_ms = (now - started) * 1000.0
                buf.extend(chunk)
                for verb, params, body in parse_tsp_frames(buf, chunk_accum):
                    if verb == "da1":
                        write_master(b"\\x1b[?62;22c")
                        continue
                    if verb == "q":
                        try:
                            qobj = json.loads(body.decode("utf-8", errors="replace"))
                            if qobj.get("q") == "hello":
                                write_master(f"\\x1b_tsp;r;{HELLO_REPLY}\\x1b\\\\".encode("utf-8"))
                        except Exception:
                            pass
                    elif verb == "f":
                        frames += 1
                        if first_frame_ms is None:
                            first_frame_ms = (now - started) * 1000.0
                        body_text = body.decode("utf-8", errors="replace")
                        try:
                            fobj = json.loads(body_text)
                            sf = fobj.get("sf", "s1")
                            seq = fobj.get("s", frames)
                            ack = json.dumps({"ev": "ack", "sf": sf, "s": seq})
                            write_master(f"\\x1b_tsp;e;{ack}\\x1b\\\\".encode("utf-8"))
                        except Exception:
                            pass
                        if ready_ms is None and (not ready_marker or ready_marker in body_text):
                            ready_ms = (now - started) * 1000.0
                            stream_start_ms = ready_ms
                            rss_kb, hwm_kb, cpu_s = read_proc_stats(proc.pid)
                            if hwm_kb:
                                peak_rss_kb = max(peak_rss_kb, hwm_kb)
                            if rss_kb:
                                peak_rss_kb = max(peak_rss_kb, rss_kb)
                            cpu_at_ready = cpu_s
                            if mode == "idle":
                                idle_start_t = now + 0.4
                        if mode == "stream" and done_marker in body_text and stream_done_ms is None:
                            stream_done_ms = (now - started) * 1000.0
                            rss_kb, hwm_kb, cpu_s = read_proc_stats(proc.pid)
                            if hwm_kb:
                                peak_rss_kb = max(peak_rss_kb, hwm_kb)
                            if rss_kb:
                                steady_rss_kb = rss_kb
                                peak_rss_kb = max(peak_rss_kb, rss_kb)
                            cpu_at_end = cpu_s
                            done = True
                            break

            rss_kb, hwm_kb, cpu_s = read_proc_stats(proc.pid)
            if hwm_kb:
                peak_rss_kb = max(peak_rss_kb, hwm_kb)
            if rss_kb:
                peak_rss_kb = max(peak_rss_kb, rss_kb)

            if mode == "idle" and idle_start_t is not None:
                if idle_start_cpu is None and now >= idle_start_t:
                    idle_start_cpu = cpu_s
                    idle_start_t = now
                elif idle_start_cpu is not None and (now - idle_start_t) >= idle_window_s:
                    steady_rss_kb = rss_kb
                    cpu_at_end = cpu_s
                    done = True
                    break

            if proc.poll() is not None:
                break
    finally:
        try:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=3.0)
        except Exception:
            try:
                proc.kill()
                proc.wait(timeout=1.0)
            except Exception:
                pass
        try:
            os.close(master)
        except OSError:
            pass

    idle_cpu_pct = None
    if mode == "idle" and idle_start_cpu is not None and cpu_at_end is not None and idle_start_t is not None:
        dt = max(0.001, idle_window_s)
        idle_cpu_pct = ((cpu_at_end - idle_start_cpu) / dt) * 100.0

    stream_wall_ms = None
    stream_cpu_pct = None
    stream_fps = None
    if mode == "stream" and stream_start_ms is not None and stream_done_ms is not None:
        stream_wall_ms = max(1.0, stream_done_ms - stream_start_ms)
        stream_fps = (frames / (stream_wall_ms / 1000.0))
        if cpu_at_ready is not None and cpu_at_end is not None:
            stream_cpu_pct = ((cpu_at_end - cpu_at_ready) / (stream_wall_ms / 1000.0)) * 100.0

    print(json.dumps({
        "first_output_ms": first_output_ms,
        "first_frame_ms": first_frame_ms,
        "ready_ms": ready_ms,
        "stream_wall_ms": stream_wall_ms,
        "frames": frames,
        "fps": stream_fps,
        "wire_bytes": wire_bytes,
        "steady_rss_mb": (steady_rss_kb / 1024.0) if steady_rss_kb is not None else None,
        "peak_rss_mb": (peak_rss_kb / 1024.0) if peak_rss_kb else None,
        "startup_cpu_ms": (cpu_at_ready * 1000.0) if cpu_at_ready is not None else None,
        "idle_cpu_pct": idle_cpu_pct,
        "stream_cpu_pct": stream_cpu_pct,
    }))

if __name__ == "__main__":
    main()
`;

function pickEntrypoint(targetRoot: string): string {
  const distEntry = join(targetRoot, 'dist/cli.js');
  return existsSync(distEntry) ? 'dist/cli.js' : 'src/cli.tsx';
}

function runPtyIdleSuite(targetRoot: string, tmpBase: string): PtyIdleResult {
  const driverPath = join(tmpBase, 'pty_driver.py');
  writeFileSync(driverPath, PYTHON_PTY_DRIVER);
  const workspace = join(tmpBase, 'idle-ws');
  mkdirSync(workspace, { recursive: true });
  const env = makeIsolatedEnv(join(tmpBase, 'idle-env'));
  const entrypoint = pickEntrypoint(targetRoot);
  const fixturePath = join(targetRoot, 'test/fixtures/agent.ts');
  const cfg = JSON.stringify({
    mode: 'idle',
    cmd: ['bun', join(targetRoot, entrypoint), '--cwd', workspace, '--agy', fixturePath],
    cwd: targetRoot,
    timeout_s: 15.0,
    idle_window_s: 3.0,
    ready_marker: 'Ready',
  });
  const res = spawnSync('python3', [driverPath, cfg], { env, encoding: 'utf8', timeout: 25_000 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`pty-idle failed (${res.status}): ${res.stderr}`);
  }
  const parsed = JSON.parse(res.stdout.trim());
  return {
    entrypoint,
    first_output_ms: round(parsed.first_output_ms),
    first_frame_ms: round(parsed.first_frame_ms),
    ready_ms: round(parsed.ready_ms),
    frames: parsed.frames,
    wire_bytes: parsed.wire_bytes,
    steady_rss_mb: round(parsed.steady_rss_mb),
    peak_rss_mb: round(parsed.peak_rss_mb),
    startup_cpu_ms: round(parsed.startup_cpu_ms),
    idle_cpu_pct: round(parsed.idle_cpu_pct),
  };
}

function createLagProbeScript(tmpBase: string, outPath: string): string {
  const probePath = join(tmpBase, 'lag_probe.ts');
  writeFileSync(probePath, `
import { writeFileSync } from 'node:fs';
const samples: number[] = [];
const intervalMs = 10;
let expected = performance.now() + intervalMs;
const timer = setInterval(() => {
  const now = performance.now();
  const lag = Math.max(0, now - expected);
  samples.push(lag);
  expected = now + intervalMs;
}, intervalMs);
timer.unref?.();
function flush() {
  try {
    writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(samples));
  } catch {}
}
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('exit', flush);
`);
  return probePath;
}

function createStreamMockAgent(targetRoot: string, tmpBase: string): string {
  const sdkPath = join(targetRoot, 'node_modules/@agentclientprotocol/sdk/dist/v1/stable/acp.js');
  const fallbackSdk = '@agentclientprotocol/sdk';
  const importTarget = existsSync(sdkPath) ? sdkPath : fallbackSdk;
  const mockPath = join(tmpBase, 'mock_acp_stream.ts');
  writeFileSync(mockPath, `#!/usr/bin/env bun
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from ${JSON.stringify(importTarget)};

function makeLines(count: number, prefix: string, salt: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(\`\${prefix} line \${String(i).padStart(4, '0')} token=\${(i * 17 + salt) % 97}\`);
  }
  return lines.join('\\n') + '\\n';
}

const sessionId = 'bench-stream-session';
const conn = agent({ name: 'bench-acp-stream' })
  .onRequest(methods.agent.initialize, async () => ({
    protocolVersion: PROTOCOL_VERSION,
    authMethods: [{ id: 'terminal-login', name: 'Terminal', type: 'terminal', args: ['--login'] }],
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {}, additionalDirectories: {} },
      promptCapabilities: { image: true, embeddedContext: true },
    },
    agentInfo: { name: 'bench-acp-stream', version: '1' },
  }))
  .onRequest(methods.agent.session.new, async () => ({
    sessionId,
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'bench-fast',
        options: [{ value: 'bench-fast', name: 'Bench Fast' }],
      },
    ],
  }))
  .onRequest(methods.agent.session.prompt, async ({ client }) => {
    const notify = (update: unknown) =>
      client.notify(methods.client.session.update, { sessionId, update } as never);

    for (let d = 0; d < 20; d++) {
      const oldText = makeLines(300, \`file_\${d}\`, 1);
      const newLines = oldText.split('\\n');
      for (let k = 10; k < 290; k += 15) {
        newLines[k] = \`file_\${d} edited line \${k} rev=\${d}\`;
      }
      const newText = newLines.join('\\n');
      await notify({
        sessionUpdate: 'tool_call',
        toolCallId: \`diff-\${d}\`,
        name: 'edit_file',
        kind: 'edit',
        title: \`Edit src/mod-\${d}.ts\`,
        status: 'completed',
        content: [{ type: 'diff', path: \`src/mod-\${d}.ts\`, oldText, newText }],
      });
      await Bun.sleep(4);
    }

    for (let c = 0; c < 600; c++) {
      let chunk = \`Chunk \${c}: streaming prose tokens for benchmark evaluation. \`;
      if (c === 40) chunk += '\\n\\n\`\`\`ts\\nexport function demo() {\\n';
      else if (c === 60) chunk += '  return 42;\\n}\\n\`\`\`\\n\\n';
      else if (c === 180) chunk += '\\n\\n\`\`\`bash\\nbun test && bun run typecheck\\n\`\`\`\\n\\n';
      await notify({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: chunk },
      });
      await Bun.sleep(4);
    }

    await notify({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '\\nBENCH_STREAM_DONE' },
    });
    return { stopReason: 'end_turn' };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

await conn.closed;
`);
  chmodSync(mockPath, 0o755);
  return mockPath;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function runPtyPacedStreamSuite(targetRoot: string, tmpBase: string): PtyPacedStreamResult {
  const driverPath = join(tmpBase, 'pty_driver.py');
  if (!existsSync(driverPath)) writeFileSync(driverPath, PYTHON_PTY_DRIVER);
  const workspace = join(tmpBase, 'stream-ws');
  mkdirSync(workspace, { recursive: true });
  const lagOutPath = join(tmpBase, 'lag-samples.json');
  const probePath = createLagProbeScript(tmpBase, lagOutPath);
  const mockAgentPath = createStreamMockAgent(targetRoot, tmpBase);
  const env = makeIsolatedEnv(join(tmpBase, 'stream-env'));
  const entrypoint = pickEntrypoint(targetRoot);

  const cfg = JSON.stringify({
    mode: 'stream',
    cmd: [
      'bun',
      '--preload',
      probePath,
      join(targetRoot, entrypoint),
      '--cwd',
      workspace,
      '--agy',
      mockAgentPath,
      '-i',
      'bench-stream',
    ],
    cwd: targetRoot,
    timeout_s: 45.0,
    ready_marker: 'Ready',
    done_marker: 'BENCH_STREAM_DONE',
  });
  const res = spawnSync('python3', [driverPath, cfg], { env, encoding: 'utf8', timeout: 55_000 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`pty-paced-stream failed (${res.status}): ${res.stderr}`);
  }
  const parsed = JSON.parse(res.stdout.trim());
  let lagSamples: number[] = [];
  if (existsSync(lagOutPath)) {
    try {
      lagSamples = JSON.parse(readFileSync(lagOutPath, 'utf8'));
    } catch {}
  }
  const sortedLag = [...lagSamples].sort((a, b) => a - b);
  return {
    entrypoint,
    ready_ms: round(parsed.ready_ms),
    stream_wall_ms: round(parsed.stream_wall_ms),
    frames: parsed.frames,
    fps: round(parsed.fps),
    wire_bytes: parsed.wire_bytes,
    cpu_pct: round(parsed.stream_cpu_pct),
    peak_rss_mb: round(parsed.peak_rss_mb),
    end_rss_mb: round(parsed.steady_rss_mb),
    lag_p50_ms: round(percentile(sortedLag, 50)),
    lag_p95_ms: round(percentile(sortedLag, 95)),
    lag_p99_ms: round(percentile(sortedLag, 99)),
    lag_max_ms: sortedLag.length ? round(sortedLag[sortedLag.length - 1]!) : null,
    lag_samples: sortedLag.length,
  };
}

function runMicroOpsSuite(targetRoot: string, tmpBase: string): MicroOpItem[] {
  const runnerPath = join(tmpBase, 'micro_ops_runner.ts');
  const uiFormatPath = join(targetRoot, 'src/ui-format.ts');
  const ternPath = join(targetRoot, 'node_modules/@stencil-hq/tern/src/index.ts');

  writeFileSync(runnerPath, `
import * as uiFormat from ${JSON.stringify(uiFormatPath)};
import { View, ui } from ${JSON.stringify(ternPath)};

const results: Array<{ name: string; iterations: number; total_ms: number; mean_ms: number; skipped?: boolean }> = [];

function bench(name: string, iterations: number, fn: () => void) {
  fn(); // warmup
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const total = performance.now() - t0;
  results.push({
    name,
    iterations,
    total_ms: Math.round(total * 100) / 100,
    mean_ms: Math.round((total / iterations) * 1000) / 1000,
  });
}

// 1. splitMarkdownSegments incremental stream (50 steps up to ~35 KB) & uncached 35 KB
const chunks: string[] = [];
for (let i = 0; i < 1000; i++) {
  if (i % 100 === 20) chunks.push('\\n\`\`\`ts\\nconst x_' + i + ' = ' + i + ';\\n');
  else if (i % 100 === 35) chunks.push('export const y_' + i + ' = x_' + (i - 15) + ';\\n\`\`\`\\n');
  else chunks.push('Token ' + i + ' prose word ');
}
const fullMd = chunks.join('');
const streamPrefixes: string[] = [];
for (let s = 1; s <= 50; s++) {
  streamPrefixes.push(fullMd.slice(0, Math.floor((fullMd.length * s) / 50)));
}
bench('splitMarkdownSegments (50-step 35KB stream)', 5, () => {
  for (const p of streamPrefixes) uiFormat.splitMarkdownSegments(p);
});
bench('splitMarkdownSegments (35KB unique)', 20, () => {
  uiFormat.splitMarkdownSegments(fullMd + ' ');
});

// 2. buildUnifiedDiffHunks on 400-line (~22 KB) diff (first cold + repeat cached)
const old400 = Array.from({ length: 400 }, (_, i) => \`const line_\${i} = "value_\${i}_padding_text_here";\`).join('\\n');
const new400 = Array.from({ length: 400 }, (_, i) => (
  i % 17 === 0 ? \`const line_\${i} = "modified_\${i}_padding_text_here";\` : \`const line_\${i} = "value_\${i}_padding_text_here";\`
)).join('\\n');
bench('buildUnifiedDiffHunks (22KB 400-line repeat)', 10, () => {
  uiFormat.buildUnifiedDiffHunks(old400, new400);
});

const countFn = (uiFormat as Record<string, unknown>).countDiffLines;
if (typeof countFn === 'function') {
  bench('countDiffLines (22KB 400-line)', 50, () => {
    (countFn as (a: string, b: string) => unknown)(old400, new400);
  });
} else {
  results.push({ name: 'countDiffLines (22KB 400-line)', iterations: 0, total_ms: 0, mean_ms: 0, skipped: true });
}

// 3. searchTranscript on 150 entries (50 turns with 400-line diffs)
const entries: any[] = [];
for (let i = 0; i < 50; i++) {
  entries.push({ id: \`u-\${i}\`, type: 'message', role: 'user', text: \`Question \${i} about auth module\` });
  entries.push({
    id: \`t-\${i}\`,
    type: 'tool',
    call: {
      toolCallId: \`tc-\${i}\`,
      name: 'edit_file',
      kind: 'edit',
      title: \`Edit file \${i}\`,
      status: 'completed',
      content: [{ type: 'diff', path: \`src/f\${i}.ts\`, oldText: old400, newText: new400 }],
    },
  });
  entries.push({ id: \`a-\${i}\`, type: 'message', role: 'assistant', text: \`Completed edit \${i} safely.\` });
}
const searchCachedFn = (uiFormat as Record<string, unknown>).searchTranscriptCached;
bench('searchTranscript (150 entries, 50 diffs)', 10, () => {
  if (typeof searchCachedFn === 'function') {
    (searchCachedFn as (e: any[], r: number, c: string, q: string) => unknown)(entries, 1, '/tmp/ws', 'modified');
  } else {
    uiFormat.searchTranscript(entries, '/tmp/ws', 'modified');
  }
});

// 4. Tern View.from + oldView.ops on 45 entries x 100 frames
function buildView(step: number) {
  const children = [];
  for (let i = 0; i < 45; i++) {
    const text = i === 44 ? \`Streaming tail token \${step}\` : \`Settled entry \${i} body content\`;
    children.push(ui.message({ key: \`e-\${i}\`, side: i % 2 === 0 ? 'end' : 'start' }, ui.md({ key: 'md' }, text)));
  }
  return {
    main: ui.col({ key: 'root' }, ui.scroll({ key: 'conversation' }, ...children)),
  };
}
let prev = View.from(buildView(0));
bench('Tern View.from + ops (45 entries)', 100, () => {
  const next = View.from(buildView(Math.floor(Math.random() * 1000)));
  prev.ops(next, 's1');
  prev = next;
});

console.log(JSON.stringify(results));
`);

  const res = spawnSync('bun', [runnerPath], { cwd: targetRoot, encoding: 'utf8', timeout: 30_000 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`micro-ops failed (${res.status}): ${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim());
}

function runOmpCompareSuite(tmpBase: string, warmRuns: number): OmpCompareResult {
  const ompBin = Bun.which('omp');
  if (!ompBin) {
    return { skipped: true, reason: 'omp not found on PATH' };
  }
  const versionRes = spawnSync(ompBin, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  const version = (versionRes.stdout || versionRes.stderr || '').trim();
  const cli: CliStartupMetric[] = [];
  for (const [label, args] of [['omp --version', ['--version']], ['omp --help', ['--help']]] as const) {
    const env = makeIsolatedEnv(join(tmpBase, `omp-env-${args[0].slice(2)}`));
    try {
      cli.push(measureCliStartupGroup(label, [ompBin, ...args], tmpBase, env, Math.min(warmRuns, 3)));
    } catch (err) {
      cli.push({
        label,
        skipped: true,
        reason: err instanceof Error ? err.message.split('\n')[0] : String(err),
        runs: 0,
        cold_ms: null,
        warm_median_ms: null,
        warm_min_ms: null,
        warm_max_ms: null,
        median_rss_mb: null,
        max_rss_mb: null,
      });
    }
  }

  const driverPath = join(tmpBase, 'pty_driver.py');
  if (!existsSync(driverPath)) writeFileSync(driverPath, PYTHON_PTY_DRIVER);
  const workspace = join(tmpBase, 'omp-ws');
  mkdirSync(workspace, { recursive: true });
  const ptyEnv = makeIsolatedEnv(join(tmpBase, 'omp-env-pty'));
  const cfg = JSON.stringify({
    mode: 'idle',
    cmd: [ompBin, '--no-session', '--cwd', workspace],
    cwd: workspace,
    timeout_s: 15.0,
    idle_window_s: 3.0,
    ready_marker: '',
  });
  const res = spawnSync('python3', [driverPath, cfg], { env: ptyEnv, encoding: 'utf8', timeout: 25_000 });
  if (res.error || res.status !== 0) {
    return { skipped: false, version, cli };
  }
  const parsed = JSON.parse(res.stdout.trim());
  return {
    skipped: false,
    version,
    cli,
    pty_idle: {
      entrypoint: ompBin,
      first_output_ms: round(parsed.first_output_ms),
      first_frame_ms: round(parsed.first_frame_ms),
      ready_ms: round(parsed.ready_ms),
      frames: parsed.frames,
      wire_bytes: parsed.wire_bytes,
      steady_rss_mb: round(parsed.steady_rss_mb),
      peak_rss_mb: round(parsed.peak_rss_mb),
      startup_cpu_ms: round(parsed.startup_cpu_ms),
      idle_cpu_pct: round(parsed.idle_cpu_pct),
    },
  };
}

function formatMarkdownReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`## Benchmark Report (${report.gitRef})`);
  lines.push('');
  lines.push(`- Timestamp: ${report.timestamp}`);
  lines.push(`- Bun: ${report.bunVersion}`);
  lines.push('');

  if (report.suites['cli-startup']) {
    lines.push('### CLI Startup');
    lines.push('| Command | Cold (ms) | Warm Median (ms) | Median RSS (MB) | Max RSS (MB) |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const row of report.suites['cli-startup']) {
      if (row.skipped) {
        lines.push(`| ${row.label} | skipped | skipped | skipped | skipped |`);
      } else {
        lines.push(`| ${row.label} | ${row.cold_ms} | ${row.warm_median_ms} | ${row.median_rss_mb ?? '-'} | ${row.max_rss_mb ?? '-'} |`);
      }
    }
    lines.push('');
  }

  if (report.suites['pty-idle']) {
    const r = report.suites['pty-idle'];
    lines.push('### PTY Idle');
    lines.push('| Metric | Value |');
    lines.push('|---|---:|');
    lines.push(`| Entrypoint | ${r.entrypoint} |`);
    lines.push(`| First Output (ms) | ${r.first_output_ms ?? '-'} |`);
    lines.push(`| First Frame (ms) | ${r.first_frame_ms ?? '-'} |`);
    lines.push(`| Ready (ms) | ${r.ready_ms ?? '-'} |`);
    lines.push(`| Frames | ${r.frames} |`);
    lines.push(`| Wire Bytes | ${r.wire_bytes} |`);
    lines.push(`| Steady RSS (MB) | ${r.steady_rss_mb ?? '-'} |`);
    lines.push(`| Peak RSS (MB) | ${r.peak_rss_mb ?? '-'} |`);
    lines.push(`| Idle CPU (%) | ${r.idle_cpu_pct ?? '-'} |`);
    lines.push('');
  }

  if (report.suites['pty-paced-stream']) {
    const r = report.suites['pty-paced-stream'];
    lines.push('### PTY Paced Stream');
    lines.push('| Metric | Value |');
    lines.push('|---|---:|');
    lines.push(`| Stream Wall (ms) | ${r.stream_wall_ms ?? '-'} |`);
    lines.push(`| Frames / FPS | ${r.frames} (${r.fps ?? '-'} fps) |`);
    lines.push(`| CPU (%) | ${r.cpu_pct ?? '-'} |`);
    lines.push(`| Peak RSS (MB) | ${r.peak_rss_mb ?? '-'} |`);
    lines.push(`| Lag p50 / p95 / max (ms) | ${r.lag_p50_ms ?? '-'} / ${r.lag_p95_ms ?? '-'} / ${r.lag_max_ms ?? '-'} |`);
    lines.push('');
  }

  if (report.suites['micro-ops']) {
    lines.push('### Micro-Ops');
    lines.push('| Benchmark | Iterations | Total (ms) | Mean (ms) |');
    lines.push('|---|---:|---:|---:|');
    for (const item of report.suites['micro-ops']) {
      if (item.skipped) lines.push(`| ${item.name} | 0 | skipped | skipped |`);
      else lines.push(`| ${item.name} | ${item.iterations} | ${item.total_ms} | ${item.mean_ms} |`);
    }
    lines.push('');
  }

  if (report.suites['omp-compare']) {
    const o = report.suites['omp-compare'];
    lines.push('### OMP Compare');
    if (o.skipped) {
      lines.push(`Skipped: ${o.reason}`);
    } else {
      lines.push(`Version: ${o.version ?? 'unknown'}`);
      if (o.cli) {
        for (const c of o.cli) {
          lines.push(`- ${c.label}: warm median ${c.warm_median_ms} ms, RSS ${c.median_rss_mb ?? '-'} MB`);
        }
      }
      if (o.pty_idle) {
        lines.push(`- PTY idle: first frame ${o.pty_idle.first_frame_ms ?? '-'} ms, steady RSS ${o.pty_idle.steady_rss_mb ?? '-'} MB, idle CPU ${o.pty_idle.idle_cpu_pct ?? '-'}%`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function main(): void {
  const args = parseBenchArgs(process.argv.slice(2));
  const repoRoot = resolve(dirname(import.meta.dir));
  const tmpBase = mkdtempSync(join(tmpdir(), 'agy-bench-'));
  let targetRoot = repoRoot;
  let worktreePath: string | undefined;

  try {
    let gitRef = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    if (args.baseline) {
      worktreePath = join(tmpBase, 'worktree');
      execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', worktreePath, args.baseline], { stdio: 'pipe' });
      symlinkSync(join(repoRoot, 'node_modules'), join(worktreePath, 'node_modules'));
      targetRoot = worktreePath;
      gitRef = args.baseline;
    }

    const report: BenchmarkReport = {
      timestamp: new Date().toISOString(),
      target: targetRoot,
      gitRef,
      bunVersion: Bun.version,
      suites: {},
    };

    if (args.suites.includes('cli-startup')) {
      report.suites['cli-startup'] = runCliStartupSuite(targetRoot, tmpBase, args.runs);
    }
    if (args.suites.includes('pty-idle')) {
      report.suites['pty-idle'] = runPtyIdleSuite(targetRoot, tmpBase);
    }
    if (args.suites.includes('pty-paced-stream')) {
      report.suites['pty-paced-stream'] = runPtyPacedStreamSuite(targetRoot, tmpBase);
    }
    if (args.suites.includes('micro-ops')) {
      report.suites['micro-ops'] = runMicroOpsSuite(targetRoot, tmpBase);
    }
    if (args.suites.includes('omp-compare')) {
      report.suites['omp-compare'] = runOmpCompareSuite(tmpBase, args.runs);
    }

    if (args.jsonOut) {
      mkdirSync(dirname(resolve(args.jsonOut)), { recursive: true });
      writeFileSync(resolve(args.jsonOut), `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(formatMarkdownReport(report));
  } finally {
    if (worktreePath) {
      try {
        execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath], { stdio: 'pipe' });
      } catch {}
    }
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

main();
