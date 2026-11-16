import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import type { AgentOptions } from './contracts';

export type OfficialReport = 'usage' | 'credits' | 'changelog';
const execute = promisify(execFile);
const REPORTS: readonly string[] = ['usage', 'credits', 'changelog'];

export async function readOfficialReport(options: AgentOptions, command: OfficialReport, signal?: AbortSignal): Promise<string> {
  if (!REPORTS.includes(command)) throw new Error('This is not an information-only CLI command.');
  const { stdout } = await execute(options.executable ?? 'agy', [
    '--print', `/${command}`, '--output-format', 'text',
    '--disable-slash-commands=false', '--sandbox', '--print-timeout', '20s',
  ], {
    cwd: options.cwd,
    signal: options.signal && signal ? AbortSignal.any([options.signal, signal]) : signal ?? options.signal,
    timeout: 25_000,
    maxBuffer: 1_048_576,
    encoding: 'utf8',
    windowsHide: true,
  });
  const text = stripVTControlCharacters(stdout).trim();
  if (!text) throw new Error(`Official agy /${command} returned no report.`);
  return text;
}

export interface QuotaRow {
  group: string;
  limit: string;
  remaining: string;
  reset: string;
}

export function parseQuotaReport(text: string): QuotaRow[] | undefined {
  if (!text.trim()) return undefined;
  const rows: QuotaRow[] = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const cells = line.split('\t');
    if (cells.length !== 4) return undefined;
    const [group, limit, remaining, reset] = cells.map(cell => cell.trim());
    if (!group || !limit || !reset || !/^\d+(?:\.\d+)?%$/.test(remaining) || Number(remaining.slice(0, -1)) > 100) return undefined;
    rows.push({ group, limit, remaining, reset });
  }
  return rows;
}
