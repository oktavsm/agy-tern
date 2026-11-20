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

function splitQuotaLine(line: string): string[] | undefined {
  if (line.includes('\t')) {
    const cells = line.split('\t').map(cell => cell.trim());
    return cells.length === 4 ? cells : undefined;
  }
  const spaceCols = line.trim().split(/\s{2,}/).map(cell => cell.trim());
  if (spaceCols.length === 4) return spaceCols;
  const match = /^(.+?)\s{2,}(.+?)\s+(\d+(?:\.\d+)?%)\s+(.+)$/.exec(line.trim());
  if (!match) return undefined;
  return [match[1]!.trim(), match[2]!.trim(), match[3]!.trim(), match[4]!.trim()];
}

export function parseQuotaReport(text: string): QuotaRow[] | undefined {
  if (!text.trim()) return undefined;
  const rawLines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const lines = rawLines.length > 1 && /^quota\s*:?$/i.test(rawLines[0]!) ? rawLines.slice(1) : rawLines;
  const rows: QuotaRow[] = [];
  for (const line of lines) {
    const cells = splitQuotaLine(line);
    if (!cells) return undefined;
    const [group, limit, remaining, reset] = cells;
    if (!group || !limit || !reset || !/^\d+(?:\.\d+)?%$/.test(remaining!) || Number(remaining!.slice(0, -1)) > 100) {
      return undefined;
    }
    rows.push({ group, limit, remaining: remaining!, reset });
  }
  return rows.length ? rows : undefined;
}
