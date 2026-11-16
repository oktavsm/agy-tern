import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import type { AgentOptions } from './contracts';

const execute = promisify(execFile);

export interface McpServerEntry {
  name: string;
  type: string;
  status: 'enabled' | 'disabled' | string;
  target: string;
}

export interface PluginEntry {
  name: string;
  enabled: boolean;
  version?: string;
  source?: string;
  path: string;
  skills: string[];
  rules: string[];
}

export interface AgentEntry {
  name: string;
  detail: string;
}

export interface PluginValidationFinding {
  severity: 'error' | 'warning' | 'note' | string;
  file?: string;
  message: string;
}

export interface PluginValidationReport {
  dir: string;
  manifest?: string;
  name?: string;
  components: Record<string, number>;
  findings: PluginValidationFinding[];
}

export interface McpAddSpec {
  name: string;
  type?: 'stdio' | 'http';
  commandOrUrl: string;
  args?: readonly string[];
}

function validateExtensionName(kind: string, name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith('-') || /[\s\0-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`Invalid ${kind} name: ${name}`);
  }
  return trimmed;
}

async function runCliSubcommand(options: AgentOptions, args: readonly string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execute(options.executable ?? 'agy', args, {
    cwd: options.cwd,
    signal: options.signal && signal ? AbortSignal.any([options.signal, signal]) : signal ?? options.signal,
    timeout: 15_000,
    maxBuffer: 1_048_576,
    encoding: 'utf8',
    windowsHide: true,
  });
  return stripVTControlCharacters(stdout).trim();
}

/** Parse tabular stdout produced by `agy mcp list`. */
export function parseMcpList(raw: string): McpServerEntry[] {
  const text = stripVTControlCharacters(raw).trim();
  if (!text) return [];
  const rows: McpServerEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^no\b.*mcp\b/i.test(trimmed)) continue;
    if (trimmed.startsWith('NAME') && /\bTYPE\b/i.test(trimmed) && /\bSTATUS\b/i.test(trimmed)) continue;
    const singleSpaceMatch = /^(\S+)\s+(stdio|http|sse)\s+(enabled|disabled)\s*(.*)$/i.exec(trimmed);
    if (singleSpaceMatch) {
      rows.push({
        name: singleSpaceMatch[1]!,
        type: singleSpaceMatch[2]!.toLowerCase(),
        status: singleSpaceMatch[3]!.toLowerCase(),
        target: singleSpaceMatch[4]!.trim(),
      });
      continue;
    }
    const cols = trimmed.split(/\s{2,}/).map(part => part.trim()).filter(Boolean);
    if (cols.length < 3) continue;
    rows.push({
      name: cols[0]!,
      type: cols[1]!,
      status: cols[2]!.toLowerCase(),
      target: cols.slice(3).join(' '),
    });
  }
  return rows;
}

/** Parse JSON array produced by `agy plugin list --json`. */
export function parsePluginListJson(raw: string): PluginEntry[] {
  const text = stripVTControlCharacters(raw).trim();
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('Invalid plugin list JSON: expected array.');
  const plugins: PluginEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !rec.name.trim()) continue;
    plugins.push({
      name: rec.name,
      enabled: rec.enabled !== false,
      ...(typeof rec.version === 'string' && rec.version ? { version: rec.version } : {}),
      ...(typeof rec.source === 'string' && rec.source ? { source: rec.source } : {}),
      path: typeof rec.path === 'string' ? rec.path : '',
      skills: Array.isArray(rec.skills) ? rec.skills.filter((s): s is string => typeof s === 'string') : [],
      rules: Array.isArray(rec.rules) ? rec.rules.filter((r): r is string => typeof r === 'string') : [],
    });
  }
  return plugins;
}

/** Parse stdout lines produced by `agy agent`. */
export function parseAgentList(raw: string): AgentEntry[] {
  const text = stripVTControlCharacters(raw).trim();
  if (!text || /^no\b.*agents?\b/i.test(text)) return [];
  const agents: AgentEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s{2,}/).map(part => part.trim()).filter(Boolean);
    if (cols[0]?.toUpperCase() === 'NAME') continue;
    agents.push({
      name: cols[0]!,
      detail: cols.slice(1).join(' · '),
    });
  }
  return agents;
}

export async function listMcpServers(options: AgentOptions, signal?: AbortSignal): Promise<McpServerEntry[]> {
  return parseMcpList(await runCliSubcommand(options, ['mcp', 'list'], signal));
}

export async function setMcpServerEnabled(options: AgentOptions, name: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
  const target = validateExtensionName('MCP server', name);
  await runCliSubcommand(options, ['mcp', enabled ? 'enable' : 'disable', target], signal);
}

export async function listPlugins(options: AgentOptions, signal?: AbortSignal): Promise<PluginEntry[]> {
  return parsePluginListJson(await runCliSubcommand(options, ['plugin', 'list', '--json'], signal));
}

export async function setPluginEnabled(options: AgentOptions, name: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
  const target = validateExtensionName('plugin', name);
  await runCliSubcommand(options, ['plugin', enabled ? 'enable' : 'disable', target], signal);
}

export async function listAgents(options: AgentOptions, signal?: AbortSignal): Promise<AgentEntry[]> {
  return parseAgentList(await runCliSubcommand(options, ['agent'], signal));
}

function tokenizeSimpleArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (quote) throw new Error('Unterminated quote in command specification.');
  if (current) tokens.push(current);
  return tokens;
}

/** Parse `[--type stdio|http] <name> <commandOrUrl> [args...]` safely without shell evaluation. */
export function parseMcpAddCommand(raw: string): McpAddSpec {
  const tokens = tokenizeSimpleArgs(raw.trim());
  let explicitType: 'stdio' | 'http' | undefined;
  let index = 0;
  if (tokens[index] === '--type') {
    const value = tokens[index + 1];
    if (value !== 'stdio' && value !== 'http') {
      throw new Error('`--type` must be `stdio` or `http`.');
    }
    explicitType = value;
    index += 2;
  }
  const rest = tokens.slice(index);
  if (rest.length < 2) {
    throw new Error('Expected `[--type stdio|http] <name> <commandOrUrl> [args...]`.');
  }
  const name = validateExtensionName('MCP server', rest[0]!);
  const commandOrUrl = rest[1]!;
  if (/[\0-\u001f\u007f]/.test(commandOrUrl)) {
    throw new Error('Invalid control character in MCP target.');
  }
  const type = explicitType ?? (/^https?:\/\//i.test(commandOrUrl) ? 'http' : 'stdio');
  return {
    name,
    type,
    commandOrUrl,
    args: rest.slice(2),
  };
}

export async function addMcpServer(options: AgentOptions, spec: McpAddSpec, signal?: AbortSignal): Promise<void> {
  const name = validateExtensionName('MCP server', spec.name);
  const target = spec.commandOrUrl.trim();
  if (!target || /[\0-\u001f\u007f]/.test(target)) {
    throw new Error('Invalid MCP command or URL.');
  }
  const type = spec.type ?? (/^https?:\/\//i.test(target) ? 'http' : 'stdio');
  const args = ['mcp', 'add', '--type', type, name, '--', target, ...(spec.args ?? [])];
  await runCliSubcommand(options, args, signal);
}

export async function removeMcpServer(options: AgentOptions, name: string, signal?: AbortSignal): Promise<void> {
  const target = validateExtensionName('MCP server', name);
  await runCliSubcommand(options, ['mcp', 'remove', target], signal);
}

/** Parse JSON output produced by `agy plugin validate --json`. */
export function parsePluginValidationJson(raw: string): PluginValidationReport {
  const text = stripVTControlCharacters(raw).trim();
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid plugin validation JSON.');
  }
  const rec = parsed as Record<string, unknown>;
  const components: Record<string, number> = {};
  if (typeof rec.components === 'object' && rec.components !== null && !Array.isArray(rec.components)) {
    for (const [k, v] of Object.entries(rec.components as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) components[k] = v;
    }
  }
  const findings: PluginValidationFinding[] = [];
  if (Array.isArray(rec.findings)) {
    for (const item of rec.findings) {
      if (typeof item !== 'object' || item === null) continue;
      const f = item as Record<string, unknown>;
      if (typeof f.message !== 'string') continue;
      findings.push({
        severity: typeof f.severity === 'string' ? f.severity : 'note',
        ...(typeof f.file === 'string' ? { file: f.file } : {}),
        message: f.message,
      });
    }
  }
  return {
    dir: typeof rec.dir === 'string' ? rec.dir : '',
    ...(typeof rec.manifest === 'string' ? { manifest: rec.manifest } : {}),
    ...(typeof rec.name === 'string' ? { name: rec.name } : {}),
    components,
    findings,
  };
}

export async function validatePlugin(
  options: AgentOptions,
  targetPath: string,
  strict = false,
  signal?: AbortSignal,
): Promise<PluginValidationReport> {
  const cleaned = targetPath.trim();
  if (!cleaned || cleaned.startsWith('-') || /[\0-\u001f\u007f]/.test(cleaned)) {
    throw new Error(`Invalid plugin path: ${targetPath}`);
  }
  const args = ['plugin', 'validate', cleaned, '--json', ...(strict ? ['--strict'] : [])];
  try {
    const out = await runCliSubcommand(options, args, signal);
    return parsePluginValidationJson(out);
  } catch (error) {
    // `agy plugin validate --json` writes valid JSON to stdout even when findings cause exit code != 0.
    if (typeof error === 'object' && error !== null && 'stdout' in error && typeof (error as { stdout?: unknown }).stdout === 'string') {
      const stdout = (error as { stdout: string }).stdout.trim();
      if (stdout.startsWith('{')) return parsePluginValidationJson(stdout);
    }
    throw error;
  }
}

export async function installPlugin(options: AgentOptions, target: string, signal?: AbortSignal): Promise<void> {
  const cleaned = target.trim();
  if (!cleaned || cleaned.startsWith('-') || /[\0-\u001f\u007f]/.test(cleaned)) {
    throw new Error(`Invalid plugin install target: ${target}`);
  }
  await runCliSubcommand(options, ['plugin', 'install', cleaned], signal);
}

export async function uninstallPlugin(options: AgentOptions, name: string, signal?: AbortSignal): Promise<void> {
  const target = validateExtensionName('plugin', name);
  await runCliSubcommand(options, ['plugin', 'uninstall', target], signal);
}
