import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ImageAttachment, ResourceAttachment } from './contracts';
import type { Draft } from './draft';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function imageMimeType(filePath: string): string | undefined {
  return IMAGE_MIME[extname(filePath).toLowerCase()];
}

export interface LoadedImageAttachment extends ImageAttachment {
  path: string;
  size: number;
}

export interface GitStatusEntry {
  status: string;
  path: string;
}

/** Read a workspace image file safely for ACP image prompt blocks. */
export async function readImageAttachment(cwd: string, filePath: string): Promise<LoadedImageAttachment> {
  const mimeType = imageMimeType(filePath);
  if (!mimeType) throw new Error(`Unsupported image format: ${extname(filePath) || filePath}`);
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  const info = await stat(abs);
  if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds 10 MB limit (${(info.size / (1024 * 1024)).toFixed(1)} MB).`);
  }
  const buffer = await readFile(abs);
  return {
    path: isAbsolute(filePath) ? filePath : relative(resolve(cwd), abs),
    mimeType,
    size: buffer.byteLength,
    data: buffer.toString('base64'),
  };
}

/** Read git working tree changes without modifying workspace state. */
export async function detectGitStatus(cwd: string, limit = 100): Promise<GitStatusEntry[]> {
  return new Promise(resolvePromise => {
    const child = spawn('git', ['status', '--short', '--untracked-files=all'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolvePromise([]);
    }, 1_500);
    child.stdout.on('data', chunk => {
      if (out.length < 128_000) out += String(chunk);
    });
    child.once('error', () => { clearTimeout(timer); resolvePromise([]); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) { resolvePromise([]); return; }
      const entries: GitStatusEntry[] = [];
      for (const rawLine of out.split(/\r?\n/)) {
        if (rawLine.length < 4) continue;
        const status = rawLine.slice(0, 2).trim() || '?';
        const path = rawLine.slice(3).trim();
        if (path) entries.push({ status, path });
        if (entries.length >= limit) break;
      }
      resolvePromise(entries);
    });
  });
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.tmp']);

export interface AtMention {
  start: number;
  end: number;
  query: string;
}

/** Detect an active `@file` mention immediately preceding the caret. */
export function atMentionQuery(text: string, cursor: number): AtMention | undefined {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, safeCursor);
  const match = /(?:^|[\s(])@([^\s@]*)$/.exec(before);
  if (!match) return undefined;
  const query = match[1]!;
  const start = safeCursor - query.length - 1;
  return { start, end: safeCursor, query };
}

/** Remove the `@query` token when turning it into an attached file chip. */
export function stripAtMention(draft: Draft, mention: AtMention): Draft {
  const before = draft.text.slice(0, mention.start);
  const after = draft.text.slice(mention.end);
  const needsGap = before.endsWith(' ') && after.startsWith(' ');
  const text = needsGap ? before + after.slice(1) : before + after;
  return { text, cursor: mention.start };
}

/** Rank workspace relative paths by basename/prefix/substring relevance. */
export function filterWorkspaceFiles(files: readonly string[], query: string, limit = 10): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files.slice(0, limit);
  const scored: Array<{ path: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = basename(lower);
    let score = -1;
    if (base === needle || lower === needle) score = 0;
    else if (base.startsWith(needle)) score = 1;
    else if (lower.startsWith(needle)) score = 2;
    else if (base.includes(needle)) score = 3;
    else if (lower.includes(needle)) score = 4;
    if (score >= 0) scored.push({ path: file, score });
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map(entry => entry.path);
}

/** Format attached workspace file chips cleanly ahead of the user prompt text. */
export function formatPromptWithAttachments(text: string, attachments: readonly string[]): string {
  if (!attachments.length) return text;
  const header = attachments.map(file => `@${file}`).join(' ');
  const body = text.trim();
  return body ? `${header}\n\n${body}` : header;
}

async function listViaGit(cwd: string, limit: number): Promise<string[] | undefined> {
  return new Promise(resolve => {
    const child = spawn('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(undefined);
    }, 1_500);
    child.stdout.on('data', chunk => {
      if (out.length < 256_000) out += String(chunk);
    });
    child.once('error', () => { clearTimeout(timer); resolve(undefined); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) { resolve(undefined); return; }
      const files = out.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, limit);
      resolve(files);
    });
  });
}

async function walkDirectory(cwd: string, limit: number): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [cwd];
  while (queue.length && results.length < limit) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        results.push(relative(cwd, full));
      }
    }
  }
  return results;
}

/** List workspace files (gitignore-aware when git is present, plus any --add-dir roots). */
export async function listWorkspaceFiles(
  cwd: string,
  limit = 600,
  extraDirs: readonly string[] = [],
): Promise<string[]> {
  const seen = new Set<string>();
  const primary = (await listViaGit(cwd, limit)) ?? await walkDirectory(cwd, limit);
  const results: string[] = [];
  for (const item of primary) {
    if (!seen.has(item)) { seen.add(item); results.push(item); }
  }
  const perExtra = Math.max(40, Math.floor(limit / Math.max(1, extraDirs.length + 1)));
  for (const extra of extraDirs) {
    if (results.length >= limit) break;
    const root = isAbsolute(extra) ? resolve(extra) : resolve(cwd, extra);
    if (root === resolve(cwd)) continue;
    const files = (await listViaGit(root, perExtra)) ?? await walkDirectory(root, perExtra);
    for (const rel of files) {
      if (results.length >= limit) break;
      const abs = resolve(root, rel);
      if (!seen.has(abs)) { seen.add(abs); results.push(abs); }
    }
  }
  return results;
}

/** Detect if bracketed-paste / dropped text refers to an existing local image file. */
export function resolvePastedImagePath(cwd: string, rawText: string): string | undefined {
  const trimmed = rawText.trim();
  if (!trimmed || trimmed.includes('\n')) return undefined;
  let candidate = trimmed;
  if ((candidate.startsWith("'") && candidate.endsWith("'")) || (candidate.startsWith('"') && candidate.endsWith('"'))) {
    candidate = candidate.slice(1, -1);
  }
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return undefined;
    }
  } else {
    candidate = candidate.replace(/\\([ \\'"])/g, '$1');
  }
  if (!imageMimeType(candidate)) return undefined;
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
  try {
    if (!statSync(abs).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return abs;
}

/** Write an exported conversation Markdown or JSON file safely inside the workspace directory. */
export async function writeTranscriptExport(cwd: string, contents: string, requestedName?: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const rawName = requestedName?.trim() || `agy-session-${stamp}.md`;
  const fileName = rawName.endsWith('.md') || rawName.endsWith('.json') ? rawName : `${rawName}.md`;
  const root = resolve(cwd);
  const target = resolve(root, fileName);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Export path must stay inside the active workspace.');
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
  return rel;
}

/** Read a bounded UTF-8 text preview of a workspace file for inline inspection. */
export async function readWorkspaceTextPreview(cwd: string, filePath: string, maxBytes = 64 * 1024): Promise<{ path: string; text: string; truncated: boolean }> {
  const root = resolve(cwd);
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const info = await stat(abs);
  if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
  const buffer = await readFile(abs);
  const truncated = buffer.byteLength > maxBytes;
  const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
  return {
    path: isAbsolute(filePath) ? filePath : relative(root, abs),
    text: new TextDecoder('utf-8', { fatal: false }).decode(slice),
    truncated,
  };
}

/** Read attached workspace text files as native ACP embeddedContext resource blocks when supported. */
export async function loadEmbeddedResourceAttachments(
  cwd: string,
  filePaths: readonly string[],
  maxBytesPerFile = 64 * 1024,
): Promise<{ resources: ResourceAttachment[]; overflowPaths: string[] }> {
  const resources: ResourceAttachment[] = [];
  const overflowPaths: string[] = [];
  const root = resolve(cwd);
  for (const filePath of filePaths) {
    try {
      const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
      const info = await stat(abs);
      if (!info.isFile() || info.size > maxBytesPerFile) {
        overflowPaths.push(filePath);
        continue;
      }
      const buffer = await readFile(abs);
      if (buffer.includes(0)) {
        overflowPaths.push(filePath);
        continue;
      }
      resources.push({
        uri: pathToFileURL(abs).href,
        mimeType: 'text/plain',
        text: buffer.toString('utf8'),
      });
    } catch {
      overflowPaths.push(filePath);
    }
  }
  return { resources, overflowPaths };
}
