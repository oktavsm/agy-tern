import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

const CLIPBOARD_IMAGE_MIMES: ReadonlyArray<{ mime: string; ext: string }> = [
  { mime: 'image/png', ext: 'png' },
  { mime: 'image/jpeg', ext: 'jpg' },
  { mime: 'image/webp', ext: 'webp' },
];

export type ClipboardExec = (cmd: string, args: string[], maxBytes: number) => Promise<Buffer | undefined>;

async function runBinaryCommand(cmd: string, args: string[], maxBytes: number): Promise<Buffer | undefined> {
  const bin = Bun.which(cmd);
  if (!bin) return undefined;
  return new Promise(resolvePromise => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Buffer | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(undefined);
    }, 2_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total <= maxBytes) chunks.push(chunk);
      else {
        child.kill('SIGTERM');
        finish(Buffer.concat(chunks, Math.min(total, maxBytes)));
      }
    });
    child.once('error', () => finish(undefined));
    child.once('close', code => finish(code === 0 ? Buffer.concat(chunks) : undefined));
  });
}

/**
 * Read a PNG/JPEG/WebP screenshot or copied image file directly from the system clipboard.
 * Supports `wl-paste` / `xclip` (including `text/uri-list` from file managers), `pngpaste` + built-in `osascript`
 * on macOS, and `powershell.exe` on WSL. Enforces the 10 MB ACP attachment limit without shell interpolation.
 */
export async function readClipboardImage(
  options?: {
    cwd?: string;
    exec?: ClipboardExec;
    hasCommand?: (cmd: string) => boolean;
    platform?: NodeJS.Platform;
    waylandDisplay?: string;
  },
): Promise<LoadedImageAttachment> {
  const exec = options?.exec ?? runBinaryCommand;
  const hasCmd = options?.hasCommand ?? ((cmd: string) => !!Bun.which(cmd));
  const platform = options?.platform ?? process.platform;
  const cwd = options?.cwd ?? process.cwd();
  const isWayland = (options?.waylandDisplay ?? process.env.WAYLAND_DISPLAY ?? '').trim().length > 0;

  const tryTool = async (
    cmd: string,
    targetsArgs: string[],
    readArgsForMime: (mime: string) => string[],
  ): Promise<{ tried: boolean; loaded?: LoadedImageAttachment; error?: string }> => {
    if (!hasCmd(cmd)) return { tried: false };
    const typesBuf = await exec(cmd, targetsArgs, 32 * 1024);
    const typesText = typesBuf?.toString('utf8') ?? '';
    const offeredLines = typesText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const offeredExact = new Map(offeredLines.map(line => [line.toLowerCase(), line]));
    const findMime = (mime: string): string | undefined => {
      const direct = offeredExact.get(mime);
      if (direct) return direct;
      for (const [lower, raw] of offeredExact) {
        if (lower.startsWith(`${mime};`)) return raw;
      }
      return undefined;
    };

    let matched: (typeof CLIPBOARD_IMAGE_MIMES)[number] | undefined;
    let rawMime: string | undefined;
    for (const entry of CLIPBOARD_IMAGE_MIMES) {
      const hit = findMime(entry.mime);
      if (hit) {
        matched = entry;
        rawMime = hit;
        break;
      }
    }

    if (matched && rawMime) {
      const payload = await exec(cmd, readArgsForMime(rawMime), MAX_IMAGE_BYTES + 1);
      if (!payload || payload.byteLength === 0) {
        return { tried: true, error: 'Clipboard image payload was empty.' };
      }
      if (payload.byteLength > MAX_IMAGE_BYTES) {
        return { tried: true, error: `Clipboard image exceeds 10 MB limit (${(payload.byteLength / (1024 * 1024)).toFixed(1)} MB).` };
      }
      return {
        tried: true,
        loaded: {
          path: `clipboard-${Date.now().toString(36)}.${matched.ext}`,
          mimeType: matched.mime,
          size: payload.byteLength,
          data: payload.toString('base64'),
        },
      };
    }

    const uriMime = findMime('text/uri-list');
    if (uriMime) {
      const uriBuf = await exec(cmd, readArgsForMime(uriMime), 64 * 1024);
      const uriLines = (uriBuf?.toString('utf8') ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
      for (const uri of uriLines) {
        const resolved = resolvePastedImagePath(cwd, uri);
        if (!resolved) continue;
        try {
          return { tried: true, loaded: await readImageAttachment(cwd, resolved) };
        } catch (err) {
          return { tried: true, error: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    return { tried: true };
  };

  const tryPngpaste = async (): Promise<{ tried: boolean; loaded?: LoadedImageAttachment; error?: string }> => {
    if (!hasCmd('pngpaste')) return { tried: false };
    const payload = await exec('pngpaste', ['-'], MAX_IMAGE_BYTES + 1);
    if (!payload || payload.byteLength === 0) return { tried: true };
    if (payload.byteLength > MAX_IMAGE_BYTES) {
      return { tried: true, error: `Clipboard image exceeds 10 MB limit (${(payload.byteLength / (1024 * 1024)).toFixed(1)} MB).` };
    }
    return {
      tried: true,
      loaded: {
        path: `clipboard-${Date.now().toString(36)}.png`,
        mimeType: 'image/png',
        size: payload.byteLength,
        data: payload.toString('base64'),
      },
    };
  };

  const tryMacOsascript = async (): Promise<{ tried: boolean; loaded?: LoadedImageAttachment; error?: string }> => {
    if (!hasCmd('osascript')) return { tried: false };
    const script = [
      'ObjC.import("AppKit");',
      'var pb = $.NSPasteboard.generalPasteboard;',
      'var png = pb.dataForType($.NSPasteboardTypePNG);',
      'if (!png || png.isNil()) {',
      '  var tiff = pb.dataForType($.NSPasteboardTypeTIFF);',
      '  if (tiff && !tiff.isNil()) {',
      '    var rep = $.NSBitmapImageRep.imageRepWithData(tiff);',
      '    if (rep && !rep.isNil()) png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));',
      '  }',
      '}',
      'png && !png.isNil() ? ObjC.unwrap(png.base64EncodedStringWithOptions(0)) : "";',
    ].join('\n');
    const b64Buf = await exec('osascript', ['-l', 'JavaScript', '-e', script], Math.ceil(MAX_IMAGE_BYTES * 1.4) + 1024);
    const b64 = b64Buf?.toString('utf8').trim() ?? '';
    if (!b64) return { tried: true };
    const payload = Buffer.from(b64, 'base64');
    if (payload.byteLength === 0) return { tried: true };
    if (payload.byteLength > MAX_IMAGE_BYTES) {
      return { tried: true, error: `Clipboard image exceeds 10 MB limit (${(payload.byteLength / (1024 * 1024)).toFixed(1)} MB).` };
    }
    return {
      tried: true,
      loaded: {
        path: `clipboard-${Date.now().toString(36)}.png`,
        mimeType: 'image/png',
        size: payload.byteLength,
        data: payload.toString('base64'),
      },
    };
  };

  const tryPowershellClipboard = async (): Promise<{ tried: boolean; loaded?: LoadedImageAttachment; error?: string }> => {
    if (!hasCmd('powershell.exe')) return { tried: false };
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      'Add-Type -AssemblyName System.Drawing;',
      '$img = [System.Windows.Forms.Clipboard]::GetImage();',
      'if ($null -ne $img) {',
      '  $ms = New-Object System.IO.MemoryStream;',
      '  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);',
      '  [Convert]::ToBase64String($ms.ToArray());',
      '}',
    ].join(' ');
    const b64Buf = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], Math.ceil(MAX_IMAGE_BYTES * 1.4) + 1024);
    const b64 = b64Buf?.toString('utf8').trim() ?? '';
    if (!b64) return { tried: true };
    const payload = Buffer.from(b64, 'base64');
    if (payload.byteLength === 0) return { tried: true };
    if (payload.byteLength > MAX_IMAGE_BYTES) {
      return { tried: true, error: `Clipboard image exceeds 10 MB limit (${(payload.byteLength / (1024 * 1024)).toFixed(1)} MB).` };
    }
    return {
      tried: true,
      loaded: {
        path: `clipboard-${Date.now().toString(36)}.png`,
        mimeType: 'image/png',
        size: payload.byteLength,
        data: payload.toString('base64'),
      },
    };
  };

  const candidates = platform === 'darwin'
    ? [tryPngpaste, tryMacOsascript]
    : isWayland
      ? [
        () => tryTool('wl-paste', ['--list-types'], mime => ['--no-newline', '--type', mime]),
        () => tryTool('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], mime => ['-selection', 'clipboard', '-t', mime, '-o']),
        tryPowershellClipboard,
      ]
      : [
        () => tryTool('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], mime => ['-selection', 'clipboard', '-t', mime, '-o']),
        () => tryTool('wl-paste', ['--list-types'], mime => ['--no-newline', '--type', mime]),
        tryPowershellClipboard,
      ];

  let anyToolAvailable = false;
  for (const probe of candidates) {
    const res = await probe();
    if (res.tried) anyToolAvailable = true;
    if (res.error) throw new Error(res.error);
    if (res.loaded) return res.loaded;
  }
  if (!anyToolAvailable) {
    throw new Error(
      platform === 'darwin'
        ? 'No clipboard image utility available (install pngpaste: brew install pngpaste).'
        : isWayland
          ? 'No clipboard image utility available. Install wl-clipboard (e.g. sudo dnf install wl-clipboard or sudo apt install wl-clipboard).'
          : 'No clipboard image utility available. Install xclip (e.g. sudo dnf install xclip or sudo apt install xclip).',
    );
  }
  throw new Error('Clipboard does not contain a PNG, JPEG, or WebP image.');
}

/** Read plain UTF-8 text from the system clipboard for Ctrl+V fallback when no image is copied. */
export async function readClipboardText(
  options?: {
    exec?: ClipboardExec;
    hasCommand?: (cmd: string) => boolean;
    platform?: NodeJS.Platform;
    waylandDisplay?: string;
  },
): Promise<string | undefined> {
  const exec = options?.exec ?? runBinaryCommand;
  const hasCmd = options?.hasCommand ?? ((cmd: string) => !!Bun.which(cmd));
  const platform = options?.platform ?? process.platform;
  const isWayland = (options?.waylandDisplay ?? process.env.WAYLAND_DISPLAY ?? '').trim().length > 0;
  const maxBytes = 256 * 1024;

  const commands: Array<[string, string[]]> = platform === 'darwin'
    ? [['pbpaste', []]]
    : isWayland
      ? [
        ['wl-paste', ['--no-newline']],
        ['xclip', ['-selection', 'clipboard', '-o']],
        ['xsel', ['--clipboard', '--output']],
        ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard']],
      ]
      : [
        ['xclip', ['-selection', 'clipboard', '-o']],
        ['xsel', ['--clipboard', '--output']],
        ['wl-paste', ['--no-newline']],
        ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard']],
      ];

  for (const [cmd, args] of commands) {
    if (!hasCmd(cmd)) continue;
    const out = await exec(cmd, args, maxBytes);
    if (out !== undefined) {
      const text = out.toString('utf8');
      if (text.length > 0) return text;
    }
  }
  return undefined;
}

export interface GitStatusEntry {
  status: string;
  path: string;
  staged?: boolean;
  unstaged?: boolean;
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
    const x = rawLine[0] ?? ' ';
    const y = rawLine[1] ?? ' ';
    const status = rawLine.slice(0, 2).trim() || '?';
    const path = rawLine.slice(3).trim();
    const untracked = x === '?' || y === '?';
    const staged = !untracked && x !== ' ';
    const unstaged = !untracked && y !== ' ';
    if (path) entries.push({ status, path, staged, unstaged });
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
  quoted?: boolean;
}

/**
 * Detect an active `@file`, `@dir/`, `@"path with spaces`, or `@path\ with\ spaces` mention
 * immediately preceding the caret. Ignores email addresses and completed prose mentions.
 */
export function atMentionQuery(text: string, cursor: number): AtMention | undefined {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, safeCursor);
  const quotedMatch = /(?:^|[\s(])@"([^"@\n]*)$/.exec(before);
  if (quotedMatch) {
    const query = quotedMatch[1]!;
    const start = safeCursor - query.length - 2;
    return { start, end: safeCursor, query, quoted: true };
  }
  const match = /(?:^|[\s(])@((?:\\ |[^\s@])*)$/.exec(before);
  if (!match) return undefined;
  const raw = match[1]!;
  const start = safeCursor - raw.length - 1;
  const query = raw.replace(/\\ /g, ' ');
  return { start, end: safeCursor, query };
}

/** Replace the active `@query` with a directory drill-down prefix (`@dir/` or `@"dir with space/`) keeping autocomplete open. */
export function drillDownAtMention(draft: Draft, mention: AtMention, dirPath: string): Draft {
  const normalized = ensureTrailingSlash(dirPath.replace(/\\/g, '/'));
  const needsQuote = Boolean(mention.quoted || /\s/.test(normalized));
  const inserted = needsQuote ? `@"${normalized}` : `@${normalized}`;
  const before = draft.text.slice(0, mention.start);
  const after = draft.text.slice(mention.end);
  return {
    text: `${before}${inserted}${after}`,
    cursor: mention.start + inserted.length,
  };
}

/** Remove the `@query` token when turning it into an attached chip. */
export function stripAtMention(draft: Draft, mention: AtMention): Draft {
  const before = draft.text.slice(0, mention.start);
  const after = draft.text.slice(mention.end);
  const needsGap = before.endsWith(' ') && after.startsWith(' ');
  const text = needsGap ? before + after.slice(1) : before + after;
  return { text, cursor: mention.start };
}

/** Build the inline composer token displayed for an attached workspace path or image. */
export function inlineAttachmentToken(pathValue: string, kind: 'file' | 'dir' | 'image'): string {
  if (kind === 'image') return `[Image: ${basename(pathValue)}]`;
  const target = kind === 'dir' ? ensureTrailingSlash(pathValue) : pathValue;
  return /\s/.test(target) ? `@"${target}"` : `@${target}`;
}

/** Replace the active `@query` span with an inline token and trailing space. */
export function replaceAtMentionWithInlineToken(draft: Draft, mention: AtMention, token: string): Draft {
  const before = draft.text.slice(0, mention.start);
  const after = draft.text.slice(mention.end);
  const prefix = before && !/[\s(]$/.test(before) ? ' ' : '';
  const suffix = after.startsWith(' ') || after.startsWith('\n') ? '' : ' ';
  const inserted = `${prefix}${token}${suffix}`;
  const cursor = mention.start + inserted.length + (after.startsWith(' ') ? 1 : 0);
  return {
    text: `${before}${inserted}${after}`,
    cursor: Math.min(before.length + inserted.length + after.length, cursor),
  };
}

/** Insert an inline attachment token cleanly at the current composer caret. */
export function insertInlineTokenAtCursor(draft: Draft, token: string): Draft {
  const safeCursor = Math.max(0, Math.min(draft.cursor, draft.text.length));
  const before = draft.text.slice(0, safeCursor);
  const after = draft.text.slice(safeCursor);
  const prefix = before && !/[\s(\n]$/.test(before) ? ' ' : '';
  const suffix = after.startsWith(' ') || after.startsWith('\n') ? '' : ' ';
  const inserted = `${prefix}${token}${suffix}`;
  return {
    text: `${before}${inserted}${after}`,
    cursor: safeCursor + inserted.length,
  };
}

/** Remove a previously inserted inline attachment token when its chip is dismissed. */
export function removeInlineToken(draft: Draft, token: string): Draft {
  if (!token) return draft;
  const idx = draft.text.indexOf(token);
  if (idx < 0) return draft;
  let start = idx;
  let end = idx + token.length;
  if (end < draft.text.length && draft.text[end] === ' ') end++;
  else if (start > 0 && draft.text[start - 1] === ' ') start--;
  const nextText = `${draft.text.slice(0, start)}${draft.text.slice(end)}`;
  const removedLen = end - start;
  const nextCursor = draft.cursor <= start
    ? draft.cursor
    : draft.cursor >= end
      ? draft.cursor - removedLen
      : start;
  return {
    text: nextText,
    cursor: Math.max(0, Math.min(nextCursor, nextText.length)),
  };
}

function findInlineTokenRanges(text: string, needle: string): Array<{ from: number; to: number }> {
  if (!text || !needle) return [];
  const ranges: Array<{ from: number; to: number }> = [];
  let pos = 0;
  while (pos < text.length) {
    const idx = text.indexOf(needle, pos);
    if (idx < 0) break;
    const before = idx > 0 ? text[idx - 1]! : '';
    const after = idx + needle.length < text.length ? text[idx + needle.length]! : '';
    const boundaryBefore = !before || /[\s(\n]/.test(before);
    const boundaryAfter = !after || /[\s),.:;!?\n]/.test(after);
    if (boundaryBefore && boundaryAfter) {
      ranges.push({ from: idx, to: idx + needle.length });
    }
    pos = idx + needle.length;
  }
  return ranges;
}

/** Compute editor highlight ranges (`Decor[]`) for inline `@file`, `@dir/`, and `[Image: ...]` tokens. */
export function extractInlineReferenceDecor(
  text: string,
  attachedFiles: readonly string[],
  attachedDirs: readonly string[],
  attachedImages: readonly { path: string }[],
): Array<{ from: number; to: number; s: 'accent' | 'info' }> {
  if (!text) return [];
  const ranges: Array<{ from: number; to: number; s: 'accent' | 'info' }> = [];
  const collect = (needle: string, s: 'accent' | 'info'): void => {
    for (const range of findInlineTokenRanges(text, needle)) {
      ranges.push({ ...range, s });
    }
  };
  for (const file of attachedFiles) collect(inlineAttachmentToken(file, 'file'), 'accent');
  for (const dir of attachedDirs) collect(inlineAttachmentToken(dir, 'dir'), 'accent');
  for (const img of attachedImages) collect(inlineAttachmentToken(img.path, 'image'), 'info');
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return ranges;
}

function ensureTrailingSlash(pathValue: string): string {
  return pathValue.endsWith('/') ? pathValue : `${pathValue}/`;
}

function trimTrailingSlash(pathValue: string): string {
  return pathValue.replace(/\/+$/, '');
}

const VENDOR_DIR_NAMES = new Set([
  'node_modules',
  '.venv',
  'venv',
  'target',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.gradle',
  'Pods',
]);

function isVendorPath(pathValue: string): boolean {
  const clean = trimTrailingSlash(pathValue);
  if (!clean) return false;
  const first = clean.split('/')[0]!;
  return VENDOR_DIR_NAMES.has(first);
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

function isOrderedSubsequence(haystack: string, needle: string): boolean {
  if (!needle) return true;
  let pos = 0;
  for (let i = 0; i < haystack.length && pos < needle.length; i++) {
    if (haystack[i] === needle[pos]) pos++;
  }
  return pos === needle.length;
}

function compactSearchKey(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

function scoreEntryPath(entryPath: string, rawNeedle: string): number {
  const needle = rawNeedle.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const cleanNeedle = trimTrailingSlash(needle);
  const normalizedPath = entryPath.replace(/\\/g, '/');
  const cleanPath = trimTrailingSlash(normalizedPath);
  const lower = normalizedPath.toLowerCase();
  const cleanLower = cleanPath.toLowerCase();
  const base = basename(cleanPath).toLowerCase();

  // Directory drill-down mode (`@dir/`): prioritize the directory itself, then immediate children, then deeper descendants.
  if (needle.endsWith('/')) {
    if (lower === needle) return 0;
    if (lower.startsWith(needle)) {
      const rest = trimTrailingSlash(cleanLower.slice(needle.length));
      if (!rest.includes('/')) {
        return normalizedPath.endsWith('/') ? 1 : 2;
      }
      return 3;
    }
    return -1;
  }

  if (base === cleanNeedle || cleanLower === cleanNeedle || lower === needle) return 0;
  if (base.startsWith(cleanNeedle)) return 1;
  if (lower.startsWith(needle)) return 2;
  if (base.includes(cleanNeedle)) return 3;
  if (lower.includes(needle)) return 4;

  const compactNeedle = compactSearchKey(cleanNeedle);
  if (compactNeedle.length >= 2) {
    const compactBase = compactSearchKey(base);
    if (compactBase.includes(compactNeedle)) return 5;
    const compactPath = compactSearchKey(cleanLower);
    if (compactPath.includes(compactNeedle)) return 6;
  }

  const tokens = cleanNeedle.split(/[\s/_-]+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every(tok => lower.includes(tok))) {
    return tokens.every(tok => base.includes(tok)) ? 5 : 7;
  }

  if (compactNeedle.length >= 2) {
    if (isOrderedSubsequence(compactSearchKey(base), compactNeedle)) return 8;
    if (isOrderedSubsequence(compactSearchKey(cleanLower), compactNeedle)) return 9;
  }
  return -1;
}

/** Rank workspace files and directories by relevance, preserving non-ignored items first on ties. */
export function filterWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
  query: string,
  limit = 16,
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
export function filterWorkspaceFiles(files: readonly string[], query: string, limit = 16): string[] {
  return filterWorkspaceEntries(
    files.map(file => ({ path: file, kind: file.endsWith('/') ? 'dir' : 'file', ignored: false })),
    query,
    limit,
  ).map(entry => entry.path);
}

/** Format attached workspace file and directory tags cleanly ahead of the user prompt when not already inline. */
export function formatPromptWithAttachments(
  text: string,
  attachments: readonly string[],
  directories: readonly string[] = [],
): string {
  if (!attachments.length && !directories.length) return text;
  const tags = [
    ...attachments.map(file => inlineAttachmentToken(file, 'file')),
    ...directories.map(dir => inlineAttachmentToken(dir, 'dir')),
  ].filter(tag => findInlineTokenRanges(text, tag).length === 0);
  if (!tags.length) return text.trim() || text;
  const header = tags.join(' ');
  const body = text.trim();
  return body ? `${header}\n\n${body}` : header;
}

function splitNullSeparated(raw: string): string[] {
  return raw.split('\0').map(item => item.trim()).filter(Boolean);
}

async function listViaGitEntries(cwd: string, limit: number, prefix = ''): Promise<WorkspaceEntry[] | undefined> {
  const [nonIgnoredRaw, ignoredDirRaw] = await Promise.all([
    runGitCommand(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 1_024 * 1024),
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

  const nonVendorIgnoredDirs: string[] = [];
  for (const entryRel of splitNullSeparated(ignoredDirRaw ?? '')) {
    const cleanRel = trimTrailingSlash(entryRel);
    if (!cleanRel || cleanRel === '.git' || cleanRel.startsWith('.git/')) continue;
    if (entryRel.endsWith('/')) {
      const full = ensureTrailingSlash(prefix ? join(prefix, cleanRel) : cleanRel);
      if (!map.has(full)) map.set(full, { path: full, kind: 'dir', ignored: true });
      addAncestorDirs(map, trimTrailingSlash(full), true, prefix);
      if (!isVendorPath(cleanRel)) nonVendorIgnoredDirs.push(cleanRel);
    } else if (!isVendorPath(cleanRel)) {
      const full = prefix ? join(prefix, cleanRel) : cleanRel;
      if (!map.has(full)) map.set(full, { path: full, kind: 'file', ignored: true });
      addAncestorDirs(map, full, true, prefix);
    }
  }

  for (let i = 0; i < nonVendorIgnoredDirs.length && map.size < limit; i += 64) {
    const batch = nonVendorIgnoredDirs.slice(i, i + 64);
    const expandedRaw = await runGitCommand(
      cwd,
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...batch],
      512 * 1024,
    );
    if (!expandedRaw) continue;
    for (const rel of splitNullSeparated(expandedRaw)) {
      if (map.size >= limit) break;
      if (rel === '.git' || rel.startsWith('.git/')) continue;
      const full = prefix ? join(prefix, rel) : rel;
      if (!map.has(full)) map.set(full, { path: full, kind: 'file', ignored: true });
      addAncestorDirs(map, full, true, prefix);
    }
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

function sanitizePrefixPattern(query: string): { dirPrefix: string; pattern: string } | undefined {
  const clean = query.trim().replace(/^@+/, '').replace(/^"/, '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('\0') || clean.startsWith('-') || clean.split('/').some(seg => seg === '..')) {
    return undefined;
  }
  const slashIdx = clean.lastIndexOf('/');
  const dirPrefix = slashIdx >= 0 ? clean.slice(0, slashIdx + 1) : '';
  const tail = clean.slice(slashIdx + 1);
  if (dirPrefix) return { dirPrefix, pattern: tail ? `:(icase)${dirPrefix}*${tail}*` : `${dirPrefix}` };
  return { dirPrefix: '', pattern: `:(icase)*${clean}*` };
}

/**
 * Targeted workspace lookup for `@` queries beyond the initial 2,400-entry index.
 * Searches nested directories and gitignored files safely within `cwd` and `--add-dir` roots.
 */
export async function searchWorkspacePrefix(
  cwd: string,
  query: string,
  limit = 120,
  extraDirs: readonly string[] = [],
): Promise<WorkspaceEntry[]> {
  const parsed = sanitizePrefixPattern(query);
  if (!parsed) return [];
  const map = new Map<string, WorkspaceEntry>();

  const needle = query.trim().replace(/^@+/, '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

  const collectGit = async (root: string, pathPrefix = ''): Promise<boolean> => {
    const spec = parsed.dirPrefix ? [parsed.dirPrefix] : [parsed.pattern];
    if (parsed.dirPrefix) {
      const [nonIgnoredRaw, ignoredRaw] = await Promise.all([
        runGitCommand(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...spec], 512 * 1024),
        runGitCommand(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...spec], 512 * 1024),
      ]);
      if (nonIgnoredRaw === undefined) return false;
      for (const rel of splitNullSeparated(nonIgnoredRaw)) {
        if (map.size >= limit) break;
        const full = pathPrefix ? join(pathPrefix, rel) : rel;
        map.set(full, { path: full, kind: 'file', ignored: false });
        addAncestorDirs(map, full, false, pathPrefix);
      }
      for (const rel of splitNullSeparated(ignoredRaw ?? '')) {
        if (map.size >= limit) break;
        if (rel === '.git' || rel.startsWith('.git/')) continue;
        const full = pathPrefix ? join(pathPrefix, rel) : rel;
        if (!map.has(full)) map.set(full, { path: full, kind: 'file', ignored: true });
        addAncestorDirs(map, full, true, pathPrefix);
      }
      return true;
    }

    const [nonIgnoredRaw, ignoredDirRaw] = await Promise.all([
      runGitCommand(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...spec], 512 * 1024),
      runGitCommand(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], 256 * 1024),
    ]);
    if (nonIgnoredRaw === undefined) return false;
    for (const rel of splitNullSeparated(nonIgnoredRaw)) {
      if (map.size >= limit) break;
      const full = pathPrefix ? join(pathPrefix, rel) : rel;
      map.set(full, { path: full, kind: 'file', ignored: false });
      addAncestorDirs(map, full, false, pathPrefix);
    }
    const nonVendorIgnoredDirs: string[] = [];
    for (const entryRel of splitNullSeparated(ignoredDirRaw ?? '')) {
      if (map.size >= limit) break;
      const cleanRel = trimTrailingSlash(entryRel);
      if (!cleanRel || cleanRel === '.git' || cleanRel.startsWith('.git/')) continue;
      if (entryRel.endsWith('/')) {
        if (cleanRel.toLowerCase().includes(needle)) {
          const full = ensureTrailingSlash(pathPrefix ? join(pathPrefix, cleanRel) : cleanRel);
          if (!map.has(full)) map.set(full, { path: full, kind: 'dir', ignored: true });
          addAncestorDirs(map, trimTrailingSlash(full), true, pathPrefix);
        }
        if (!isVendorPath(cleanRel)) nonVendorIgnoredDirs.push(cleanRel);
      } else if (!isVendorPath(cleanRel) && cleanRel.toLowerCase().includes(needle)) {
        const full = pathPrefix ? join(pathPrefix, cleanRel) : cleanRel;
        if (!map.has(full)) map.set(full, { path: full, kind: 'file', ignored: true });
        addAncestorDirs(map, full, true, pathPrefix);
      }
    }
    for (let i = 0; i < nonVendorIgnoredDirs.length && map.size < limit; i += 64) {
      const batch = nonVendorIgnoredDirs.slice(i, i + 64);
      const expandedRaw = await runGitCommand(
        root,
        ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...batch],
        512 * 1024,
      );
      if (!expandedRaw) continue;
      for (const rel of splitNullSeparated(expandedRaw)) {
        if (map.size >= limit) break;
        if (rel === '.git' || rel.startsWith('.git/')) continue;
        if (!rel.toLowerCase().includes(needle)) continue;
        const full = pathPrefix ? join(pathPrefix, rel) : rel;
        if (!map.has(full)) map.set(full, { path: full, kind: 'file', ignored: true });
        addAncestorDirs(map, full, true, pathPrefix);
      }
    }
    return true;
  };

  const gitOk = await collectGit(cwd);
  if (parsed.dirPrefix && (!gitOk || map.size < limit)) {
    const targetDir = resolve(cwd, trimTrailingSlash(parsed.dirPrefix));
    const relTarget = relative(resolve(cwd), targetDir);
    if (!relTarget.startsWith('..') && !isAbsolute(relTarget)) {
      const walked = await walkDirectoryEntries(targetDir, limit, trimTrailingSlash(parsed.dirPrefix));
      for (const item of walked) {
        if (map.size >= limit) break;
        if (!map.has(item.path)) map.set(item.path, item);
      }
    }
  }
  if (map.size < limit) {
    for (const extra of extraDirs) {
      if (map.size >= limit) break;
      const root = isAbsolute(extra) ? resolve(extra) : resolve(cwd, extra);
      if (root === resolve(cwd)) continue;
      await collectGit(root, root);
    }
  }
  return [...map.values()].slice(0, limit);
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

function resolveSafeWorkspaceRelPath(
  cwd: string,
  filePath: string,
): { root: string; abs: string; rel: string } | undefined {
  const cleaned = filePath.trim();
  if (!cleaned || cleaned.startsWith('-') || /[\0-\u001f\u007f]/.test(cleaned)) return undefined;
  const root = resolve(cwd);
  const abs = isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return { root, abs, rel };
}

async function runGitMutation(cwd: string, args: string[], actionLabel: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectPromise(new Error(`Timed out trying to ${actionLabel}.`));
    }, 3_000);
    child.stderr?.on('data', chunk => {
      if (err.length < 4096) err += String(chunk);
    });
    child.once('error', cause => { clearTimeout(timer); rejectPromise(cause); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(err.trim() || `git ${args[0] ?? ''} exited with code ${code ?? 'unknown'}`));
    });
  });
}

/** Read working-tree or staged git diff for a workspace-relative path. */
export async function readGitFileDiff(cwd: string, filePath: string): Promise<string> {
  const target = resolveSafeWorkspaceRelPath(cwd, filePath);
  if (!target) return '';
  const unstaged = await runGitCommand(target.root, ['diff', '--no-color', '--', target.rel]);
  if (unstaged?.trim()) return unstaged;
  const staged = await runGitCommand(target.root, ['diff', '--cached', '--no-color', '--', target.rel]);
  return staged ?? '';
}

/** Stage a modified or untracked workspace path safely via git. */
export async function stageGitPath(cwd: string, filePath: string): Promise<void> {
  const target = resolveSafeWorkspaceRelPath(cwd, filePath);
  if (!target) throw new Error('Target path must stay inside the active workspace.');
  await runGitMutation(target.root, ['add', '--', target.rel], `stage ${target.rel}`);
}

/** Unstage a staged workspace path safely via git index reset. */
export async function unstageGitPath(cwd: string, filePath: string): Promise<void> {
  const target = resolveSafeWorkspaceRelPath(cwd, filePath);
  if (!target) throw new Error('Target path must stay inside the active workspace.');
  await runGitMutation(target.root, ['reset', '-q', 'HEAD', '--', target.rel], `unstage ${target.rel}`);
}

/** Discard working-tree or untracked changes for a single workspace path after confirmation. */
export async function discardGitPath(cwd: string, filePath: string, status: string): Promise<void> {
  const target = resolveSafeWorkspaceRelPath(cwd, filePath);
  if (!target) throw new Error('Target path must stay inside the active workspace.');
  if (status === '?' || status === '??') {
    await rm(target.abs, { recursive: true, force: true });
    return;
  }
  await runGitMutation(target.root, ['reset', '-q', 'HEAD', '--', target.rel], `unstage ${target.rel}`).catch(() => {});
  if (status === 'A') {
    await rm(target.abs, { recursive: true, force: true });
    return;
  }
  await runGitMutation(target.root, ['checkout', '--', target.rel], `discard ${target.rel}`);
}
