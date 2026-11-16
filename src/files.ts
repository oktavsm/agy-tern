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
  const out = await runGitCommand(cwd, ['status', '--short', '--untracked-files=all'], 128_000);
  if (out === undefined) return [];
  const entries: GitStatusEntry[] = [];
  for (const rawLine of out.split(/\r?\n/)) {
    if (rawLine.length < 4) continue;
    const status = rawLine.slice(0, 2).trim() || '?';
    const path = rawLine.slice(3).trim();
    if (path) entries.push({ status, path });
    if (entries.length >= limit) break;
  }
  return entries;
}

export interface WorkspaceEntry {
  path: string;
  kind: 'file' | 'dir';
  ignored: boolean;
}

export interface DirectoryPreviewEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  ignored: boolean;
}

export interface DirectoryPreview {
  path: string;
  entries: DirectoryPreviewEntry[];
  totalCount: number;
  truncated: boolean;
}

export interface AtMention {
  start: number;
  end: number;
  query: string;
}

/** Detect an active `@file` or `@dir/` mention immediately preceding the caret. */
export function atMentionQuery(text: string, cursor: number): AtMention | undefined {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, safeCursor);
  const match = /(?:^|[\s(])@([^\s@]*)$/.exec(before);
  if (!match) return undefined;
  const query = match[1]!;
  const start = safeCursor - query.length - 1;
  return { start, end: safeCursor, query };
}

/** Remove the `@query` token when turning it into an attached chip. */
export function stripAtMention(draft: Draft, mention: AtMention): Draft {
  const before = draft.text.slice(0, mention.start);
  const after = draft.text.slice(mention.end);
  const needsGap = before.endsWith(' ') && after.startsWith(' ');
  const text = needsGap ? before + after.slice(1) : before + after;
  return { text, cursor: mention.start };
}

function ensureTrailingSlash(pathValue: string): string {
  return pathValue.endsWith('/') ? pathValue : `${pathValue}/`;
}

function trimTrailingSlash(pathValue: string): string {
  return pathValue.replace(/\/+$/, '');
}

function isVendorPath(pathValue: string): boolean {
  const clean = trimTrailingSlash(pathValue);
  return clean === 'node_modules' || clean.startsWith('node_modules/');
}

function addAncestorDirs(
  map: Map<string, WorkspaceEntry>,
  filePath: string,
  ignored: boolean,
  prefix = '',
): void {
  const rel = prefix ? relative(prefix, filePath) : filePath;
  const parts = trimTrailingSlash(rel).split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const sub = parts.slice(0, i + 1).join('/');
    const full = ensureTrailingSlash(prefix ? join(prefix, sub) : sub);
    const existing = map.get(full);
    if (!existing) {
      map.set(full, { path: full, kind: 'dir', ignored });
    } else if (!ignored && existing.ignored) {
      // A directory containing at least one tracked/non-ignored child is not itself gitignored.
      existing.ignored = false;
    }
  }
}

function scoreEntryPath(entryPath: string, needle: string): number {
  const cleanNeedle = trimTrailingSlash(needle);
  const cleanPath = trimTrailingSlash(entryPath);
  const lower = entryPath.toLowerCase();
  const cleanLower = cleanPath.toLowerCase();
  const base = basename(cleanPath).toLowerCase();
  if (base === cleanNeedle || cleanLower === cleanNeedle || lower === needle) return 0;
  if (base.startsWith(needle) || (!needle.endsWith('/') && base.startsWith(cleanNeedle))) return 1;
  if (lower.startsWith(needle)) return 2;
  if (base.includes(cleanNeedle)) return 3;
  if (lower.includes(needle)) return 4;
  return -1;
}

/** Rank workspace files and directories by relevance, preserving non-ignored items first on ties. */
export function filterWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
  query: string,
  limit = 10,
): WorkspaceEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...entries]
      .sort((a, b) => Number(a.ignored) - Number(b.ignored) || a.path.length - b.path.length || a.path.localeCompare(b.path))
      .slice(0, limit);
  }
  const scored: Array<{ entry: WorkspaceEntry; score: number }> = [];
  for (const entry of entries) {
    const score = scoreEntryPath(entry.path, needle);
    if (score >= 0) scored.push({ entry, score });
  }
  scored.sort((a, b) =>
    a.score - b.score ||
    Number(a.entry.ignored) - Number(b.entry.ignored) ||
    a.entry.path.length - b.entry.path.length ||
    a.entry.path.localeCompare(b.entry.path));
  return scored.slice(0, limit).map(item => item.entry);
}

/** Rank workspace relative paths by basename/prefix/substring relevance. */
export function filterWorkspaceFiles(files: readonly string[], query: string, limit = 10): string[] {
  return filterWorkspaceEntries(
    files.map(file => ({ path: file, kind: file.endsWith('/') ? 'dir' : 'file', ignored: false })),
    query,
    limit,
  ).map(entry => entry.path);
}

/** Format attached workspace file and directory tags cleanly ahead of the user prompt text. */
export function formatPromptWithAttachments(
  text: string,
  attachments: readonly string[],
  directories: readonly string[] = [],
): string {
  if (!attachments.length && !directories.length) return text;
  const tags = [
    ...attachments.map(file => `@${file}`),
    ...directories.map(dir => `@${ensureTrailingSlash(dir)}`),
  ];
  const header = tags.join(' ');
  const body = text.trim();
  return body ? `${header}\n\n${body}` : header;
}

function splitNullSeparated(raw: string): string[] {
  return raw.split('\0').map(item => item.trim()).filter(Boolean);
}

async function listViaGitEntries(cwd: string, limit: number, prefix = ''): Promise<WorkspaceEntry[] | undefined> {
  const [nonIgnoredRaw, ignoredRaw, ignoredDirRaw] = await Promise.all([
    runGitCommand(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 1_024 * 1024),
    runGitCommand(cwd, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], 1_024 * 1024),
    runGitCommand(cwd, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], 256 * 1024),
  ]);
  if (nonIgnoredRaw === undefined) return undefined;

  const map = new Map<string, WorkspaceEntry>();
  if (prefix) map.set(ensureTrailingSlash(prefix), { path: ensureTrailingSlash(prefix), kind: 'dir', ignored: false });

  const nonIgnored = splitNullSeparated(nonIgnoredRaw);
  for (const rel of nonIgnored) {
    const full = prefix ? join(prefix, rel) : rel;
    map.set(full, { path: full, kind: 'file', ignored: false });
    addAncestorDirs(map, full, false, prefix);
  }

  for (const dirRel of splitNullSeparated(ignoredDirRaw ?? '')) {
    const cleanRel = trimTrailingSlash(dirRel);
    if (!cleanRel || cleanRel === '.git') continue;
    const full = ensureTrailingSlash(prefix ? join(prefix, cleanRel) : cleanRel);
    const existing = map.get(full);
    if (!existing) map.set(full, { path: full, kind: 'dir', ignored: true });
    addAncestorDirs(map, trimTrailingSlash(full), true, prefix);
  }

  const ignoredNonVendor: string[] = [];
  const ignoredVendor: string[] = [];
  for (const rel of splitNullSeparated(ignoredRaw ?? '')) {
    if (rel === '.git' || rel.startsWith('.git/')) continue;
    if (isVendorPath(rel)) {
      ignoredVendor.push(rel);
      const rootVendor = ensureTrailingSlash(prefix ? join(prefix, 'node_modules') : 'node_modules');
      if (!map.has(rootVendor)) map.set(rootVendor, { path: rootVendor, kind: 'dir', ignored: true });
    } else {
      ignoredNonVendor.push(rel);
    }
  }

  for (const rel of ignoredNonVendor) {
    if (map.size >= limit) break;
    const full = prefix ? join(prefix, rel) : rel;
    if (!map.has(full)) map.set(full, { path: full, kind: 'file', ignored: true });
    addAncestorDirs(map, full, true, prefix);
  }

  for (const rel of ignoredVendor) {
    if (map.size >= limit) break;
    const full = prefix ? join(prefix, rel) : rel;
    if (!map.has(full)) map.set(full, { path: full, kind: 'file', ignored: true });
    addAncestorDirs(map, full, true, prefix);
  }

  return [...map.values()].slice(0, limit);
}

async function walkDirectoryEntries(cwd: string, limit: number, prefix = ''): Promise<WorkspaceEntry[]> {
  const results: WorkspaceEntry[] = [];
  if (prefix) results.push({ path: ensureTrailingSlash(prefix), kind: 'dir', ignored: false });
  const queue: string[] = [cwd];
  const vendorQueue: string[] = [];

  while ((queue.length || vendorQueue.length) && results.length < limit) {
    const dir = queue.length ? queue.shift()! : vendorQueue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      const rel = relative(cwd, full);
      const pathLabel = prefix ? join(prefix, rel) : rel;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          vendorQueue.push(full);
          continue;
        }
        results.push({ path: ensureTrailingSlash(pathLabel), kind: 'dir', ignored: false });
        queue.push(full);
      } else if (entry.isFile()) {
        results.push({ path: pathLabel, kind: 'file', ignored: false });
      }
    }
    if (!queue.length && vendorQueue.length && results.length < limit) {
      for (const v of vendorQueue) {
        if (results.length >= limit) break;
        const rel = relative(cwd, v);
        results.push({ path: ensureTrailingSlash(prefix ? join(prefix, rel) : rel), kind: 'dir', ignored: false });
      }
    }
  }
  return results;
}

/** List workspace files and directories, including gitignored paths flagged as `ignored: true`, plus any `--add-dir` roots. */
export async function listWorkspaceEntries(
  cwd: string,
  limit = 2_400,
  extraDirs: readonly string[] = [],
): Promise<WorkspaceEntry[]> {
  const map = new Map<string, WorkspaceEntry>();
  const primary = (await listViaGitEntries(cwd, limit)) ?? await walkDirectoryEntries(cwd, limit);
  primary.sort((a, b) => Number(isVendorPath(a.path)) - Number(isVendorPath(b.path)) || a.path.localeCompare(b.path));
  for (const item of primary) {
    if (!map.has(item.path)) map.set(item.path, item);
  }
  const perExtra = Math.max(80, Math.floor(limit / Math.max(1, extraDirs.length + 1)));
  for (const extra of extraDirs) {
    if (map.size >= limit) break;
    const root = isAbsolute(extra) ? resolve(extra) : resolve(cwd, extra);
    if (root === resolve(cwd)) continue;
    const extraEntries = (await listViaGitEntries(root, perExtra, root)) ?? await walkDirectoryEntries(root, perExtra, root);
    extraEntries.sort((a, b) => a.path.localeCompare(b.path));
    for (const item of extraEntries) {
      if (map.size >= limit) break;
      if (!map.has(item.path)) map.set(item.path, item);
    }
  }
  return [...map.values()];
}

/** List workspace file paths (including gitignored files when git is present, plus any `--add-dir` roots). */
export async function listWorkspaceFiles(
  cwd: string,
  limit = 600,
  extraDirs: readonly string[] = [],
): Promise<string[]> {
  const entries = await listWorkspaceEntries(cwd, Math.max(limit * 3, limit), extraDirs);
  return entries.filter(entry => entry.kind === 'file').map(entry => entry.path).slice(0, limit);
}

async function detectIgnoredSet(cwd: string, candidatePaths: readonly string[]): Promise<Set<string>> {
  const ignored = new Set<string>();
  if (!candidatePaths.length) return ignored;
  const out = await runGitCommand(
    cwd,
    ['check-ignore', '--stdin', '-z'],
    128_000,
    `${candidatePaths.join('\0')}\0`,
    true,
  );
  if (out) {
    for (const item of splitNullSeparated(out)) ignored.add(trimTrailingSlash(item));
  }
  return ignored;
}

/** Read immediate directory contents cleanly for inline inspection and directory attachment previews. */
export async function listDirectoryEntriesPreview(
  cwd: string,
  dirPath: string,
  limit = 120,
): Promise<DirectoryPreview> {
  const root = resolve(cwd);
  const cleanInput = trimTrailingSlash(dirPath.trim());
  const abs = isAbsolute(cleanInput) ? resolve(cleanInput) : resolve(root, cleanInput);
  const info = await stat(abs);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);
  const rawEntries = (await readdir(abs, { withFileTypes: true }))
    .filter(entry => entry.name !== '.git')
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const totalCount = rawEntries.length;
  const truncated = totalCount > limit;
  const slice = truncated ? rawEntries.slice(0, limit) : rawEntries;
  const relDir = isAbsolute(dirPath) ? cleanInput : (relative(root, abs) || '.');
  const displayDir = ensureTrailingSlash(relDir);

  const checkCandidates: string[] = [];
  const itemPaths = slice.map(entry => {
    const childRel = relDir === '.' ? entry.name : join(relDir, entry.name);
    if (!isAbsolute(childRel) && !childRel.startsWith('..')) checkCandidates.push(childRel);
    return {
      name: entry.name,
      kind: (entry.isDirectory() ? 'dir' : 'file') as 'file' | 'dir',
      path: entry.isDirectory() ? ensureTrailingSlash(childRel) : childRel,
      checkKey: childRel,
    };
  });
  const ignoredSet = await detectIgnoredSet(root, checkCandidates);
  return {
    path: displayDir,
    totalCount,
    truncated,
    entries: itemPaths.map(item => ({
      name: item.name,
      path: item.path,
      kind: item.kind,
      ignored: ignoredSet.has(item.checkKey),
    })),
  };
}

/** Build compact ACP embeddedContext manifest blocks for attached workspace directories. */
export async function loadDirectorySummaryResources(
  cwd: string,
  dirPaths: readonly string[],
  maxEntriesPerDir = 80,
): Promise<ResourceAttachment[]> {
  const resources: ResourceAttachment[] = [];
  const root = resolve(cwd);
  for (const dirPath of dirPaths) {
    try {
      const preview = await listDirectoryEntriesPreview(root, dirPath, maxEntriesPerDir);
      const abs = isAbsolute(dirPath) ? resolve(trimTrailingSlash(dirPath)) : resolve(root, trimTrailingSlash(dirPath));
      const lines = preview.entries.map(item =>
        `- ${item.kind === 'dir' ? ensureTrailingSlash(item.name) : item.name}${item.ignored ? ' [gitignored]' : ''}`);
      if (preview.truncated) lines.push(`... (${preview.totalCount - preview.entries.length} more entries)`);
      resources.push({
        uri: pathToFileURL(abs).href,
        mimeType: 'text/plain',
        text: `Directory ${preview.path} (${preview.totalCount} items):\n${lines.join('\n')}`,
      });
    } catch {
      // Skip inaccessible directories cleanly; the @dir/ tag remains in prompt text.
    }
  }
  return resources;
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

async function runGitCommand(
  cwd: string,
  args: string[],
  maxBytes = 256 * 1024,
  stdinText?: string,
  allowExitOne = false,
): Promise<string | undefined> {
  return new Promise(resolvePromise => {
    const child = spawn('git', args, { cwd, stdio: [stdinText !== undefined ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolvePromise(undefined);
    }, 1_500);
    if (stdinText !== undefined && child.stdin) {
      child.stdin.end(stdinText);
    }
    child.stdout?.on('data', chunk => {
      if (out.length < maxBytes) out += String(chunk);
    });
    child.once('error', () => { clearTimeout(timer); resolvePromise(undefined); });
    child.once('close', code => {
      clearTimeout(timer);
      resolvePromise(code === 0 || (allowExitOne && code === 1) ? out : undefined);
    });
  });
}

/** Read working-tree or staged git diff for a workspace-relative path. */
export async function readGitFileDiff(cwd: string, filePath: string): Promise<string> {
  const cleaned = filePath.trim();
  if (!cleaned || cleaned.startsWith('-') || /[\0-\u001f\u007f]/.test(cleaned)) return '';
  const root = resolve(cwd);
  const abs = isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return '';
  const unstaged = await runGitCommand(root, ['diff', '--no-color', '--', rel]);
  if (unstaged?.trim()) return unstaged;
  const staged = await runGitCommand(root, ['diff', '--cached', '--no-color', '--', rel]);
  return staged ?? '';
}
