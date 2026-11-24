import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atMentionQuery,
  detectGitStatus,
  discardGitPath,
  drillDownAtMention,
  extractInlineReferenceDecor,
  filterWorkspaceEntries,
  filterWorkspaceFiles,
  formatPromptWithAttachments,
  imageMimeType,
  inlineAttachmentToken,
  insertInlineTokenAtCursor,
  listDirectoryEntriesPreview,
  listWorkspaceEntries,
  listWorkspaceFiles,
  loadDirectorySummaryResources,
  loadEmbeddedResourceAttachments,
  readClipboardImage,
  readClipboardText,
  readGitFileDiff,
  readImageAttachment,
  readWorkspaceTextPreview,
  removeInlineToken,
  replaceAtMentionWithInlineToken,
  resolvePastedImagePath,
  searchWorkspacePrefix,
  stageGitPath,
  stripAtMention,
  unstageGitPath,
  writeTranscriptExport,
} from '../src/files';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agy-files-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('workspace @file mention helpers', () => {
  test('detects @mention at caret and ignores email-like text', () => {
    expect(atMentionQuery('check @src/ui', 13)).toEqual({ start: 6, end: 13, query: 'src/ui' });
    expect(atMentionQuery('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(atMentionQuery('user@example.com', 16)).toBeUndefined();
    expect(atMentionQuery('check @src/ui now', 17)).toBeUndefined();
    expect(atMentionQuery('check @"My Folder/Lap', 21)).toEqual({ start: 6, end: 21, query: 'My Folder/Lap', quoted: true });
    expect(atMentionQuery('check @My\\ Folder/Lap', 21)).toEqual({ start: 6, end: 21, query: 'My Folder/Lap' });

    const dirMention = atMentionQuery('inspect @docs', 13)!;
    expect(drillDownAtMention({ text: 'inspect @docs', cursor: 13 }, dirMention, 'docs/')).toEqual({
      text: 'inspect @docs/',
      cursor: 14,
    });
    const spaceMention = atMentionQuery('inspect @my', 11)!;
    const drilledSpace = drillDownAtMention({ text: 'inspect @my', cursor: 11 }, spaceMention, 'My Folder/');
    expect(drilledSpace).toEqual({
      text: 'inspect @"My Folder/',
      cursor: 20,
    });
    expect(atMentionQuery(drilledSpace.text, drilledSpace.cursor)).toEqual({
      start: 8,
      end: 20,
      query: 'My Folder/',
      quoted: true,
    });
    expect(inlineAttachmentToken('My Folder/Laporan Akhir.pdf', 'file')).toBe('@"My Folder/Laporan Akhir.pdf"');
    expect(inlineAttachmentToken('My Folder/', 'dir')).toBe('@"My Folder/"');
  });

  test('strips @mention cleanly when converting to chip', () => {
    const mention = atMentionQuery('review @src/ui please', 14)!;
    expect(stripAtMention({ text: 'review @src/ui please', cursor: 14 }, mention)).toEqual({
      text: 'review please',
      cursor: 7,
    });
  });

  test('ranks basename matches ahead of nested substring matches', () => {
    const files = ['docs/ui-revamp.md', 'src/model.ts', 'src/ui.tsx', 'src/ui-format.ts'];
    expect(filterWorkspaceFiles(files, 'ui')).toEqual([
      'src/ui.tsx',
      'src/ui-format.ts',
      'docs/ui-revamp.md',
    ]);

    const mixed = [
      'My Folder/',
      'My Folder/Sub Folder/',
      'My Folder/Laporan Akhir 2026.pdf',
      'My Folder/Sub Folder/catatan.txt',
      'src/task-monitor.ts',
      'src/ui-format.ts',
    ];
    // Case-insensitive middle-word match
    expect(filterWorkspaceFiles(mixed, 'MONITOR')).toEqual(['src/task-monitor.ts']);
    expect(filterWorkspaceFiles(mixed, 'akhir')).toEqual(['My Folder/Laporan Akhir 2026.pdf']);
    // Space-separated multi-token & compact match
    expect(filterWorkspaceFiles(mixed, 'laporan 2026')).toEqual(['My Folder/Laporan Akhir 2026.pdf']);
    expect(filterWorkspaceFiles(mixed, 'myfolder')).toContain('My Folder/');
    // Ordered fuzzy subsequence match
    expect(filterWorkspaceFiles(mixed, 'ufmt')).toEqual(['src/ui-format.ts']);
    // Directory drill-down puts directory first, then immediate children, then deeper descendants
    expect(filterWorkspaceFiles(mixed, 'My Folder/')).toEqual([
      'My Folder/',
      'My Folder/Sub Folder/',
      'My Folder/Laporan Akhir 2026.pdf',
      'My Folder/Sub Folder/catatan.txt',
    ]);
  });

  test('prepends attached file chips cleanly to prompt text', () => {
    expect(formatPromptWithAttachments('Explain this', [])).toBe('Explain this');
    expect(formatPromptWithAttachments('Explain this', ['src/ui.tsx', 'package.json'])).toBe(
      '@src/ui.tsx @package.json\n\nExplain this',
    );
  });

  test('walks directory cleanly when not a git repo while deferring vendor directories', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'README.md'), 'hi');
    await writeFile(join(dir, 'src', 'app.ts'), 'export {}');
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
    const files = await listWorkspaceFiles(dir, 2);
    expect(files).toEqual(['README.md', 'src/app.ts']);
    const allFiles = await listWorkspaceFiles(dir);
    expect(allFiles).toEqual(['README.md', 'src/app.ts', 'node_modules/pkg/index.js']);
  });

  test('detects image mime types and loads base64 image attachments safely', async () => {
    expect(imageMimeType('shot.PNG')).toBe('image/png');
    expect(imageMimeType('photo.jpeg')).toBe('image/jpeg');
    expect(imageMimeType('src/ui.tsx')).toBeUndefined();

    const dir = await tempDir();
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(join(dir, 'sample.png'), bytes);
    const loaded = await readImageAttachment(dir, 'sample.png');
    expect(loaded).toEqual({
      path: 'sample.png',
      mimeType: 'image/png',
      size: bytes.byteLength,
      data: Buffer.from(bytes).toString('base64'),
    });

    await writeFile(join(dir, 'notes.txt'), 'not an image');
    await expect(readImageAttachment(dir, 'notes.txt')).rejects.toThrow('Unsupported image format');

    const imgAbs = join(dir, 'sample.png');
    expect(resolvePastedImagePath(dir, `'${imgAbs}'`)).toBe(imgAbs);
    expect(resolvePastedImagePath(dir, `file://${imgAbs}`)).toBe(imgAbs);
    expect(resolvePastedImagePath(dir, 'sample.png')).toBe(imgAbs);
    expect(resolvePastedImagePath(dir, join(dir, 'missing.png'))).toBeUndefined();
    expect(resolvePastedImagePath(dir, 'plain pasted text')).toBeUndefined();

    const relExport = await writeTranscriptExport(dir, '# Exported\n', 'docs/chat');
    expect(relExport).toBe('docs/chat.md');
    const jsonExport = await writeTranscriptExport(dir, '{"ok":true}\n', 'docs/chat.json');
    expect(jsonExport).toBe('docs/chat.json');
    await expect(writeTranscriptExport(dir, '# Bad\n', '../escape.md')).rejects.toThrow('inside the active workspace');
  });

  test('reads workspace text previews with truncation guard', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'big.txt'), 'abcdef'.repeat(20));
    const small = await readWorkspaceTextPreview(dir, 'big.txt', 200);
    expect(small).toEqual({ path: 'big.txt', text: 'abcdef'.repeat(20), truncated: false });
    const cut = await readWorkspaceTextPreview(dir, 'big.txt', 12);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe('abcdefabcdef');
  });

  test('indexes --add-dir roots and builds embeddedContext resources safely', async () => {
    const dir = await tempDir();
    const extra = await tempDir();
    await writeFile(join(dir, 'main.ts'), 'console.log(1);\n');
    await writeFile(join(extra, 'shared.ts'), 'export const x = 42;\n');
    await writeFile(join(dir, 'bin.dat'), Uint8Array.from([0, 1, 2, 3]));

    const indexed = await listWorkspaceFiles(dir, 100, [extra]);
    expect(indexed).toEqual(['bin.dat', 'main.ts', join(extra, 'shared.ts')]);

    const embedded = await loadEmbeddedResourceAttachments(dir, ['main.ts', join(extra, 'shared.ts'), 'bin.dat']);
    expect(embedded.resources).toHaveLength(2);
    expect(embedded.resources[0]?.text).toBe('console.log(1);\n');
    expect(embedded.resources[1]?.text).toBe('export const x = 42;\n');
    expect(embedded.overflowPaths).toEqual(['bin.dat']);
  });

  test('guards git file diff lookups against invalid flags or workspace escapes', async () => {
    const dir = await tempDir();
    expect(await readGitFileDiff(dir, '--all')).toBe('');
    expect(await readGitFileDiff(dir, '../outside.ts')).toBe('');
    expect(await readGitFileDiff(dir, 'not-a-git-repo.ts')).toBe('');
  });

  test('lists all files and directories including gitignored entries with explicit flags', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'docs', 'screenshots'), { recursive: true });
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, '.gitignore'), '.env\ndist/\ndocs/screenshots/\n');
    await writeFile(join(dir, 'src', 'app.ts'), 'export const ok = true;\n');
    await writeFile(join(dir, 'docs', 'guide.md'), '# Guide\n');
    await writeFile(join(dir, 'docs', 'screenshots', 'home.png'), 'png');
    await writeFile(join(dir, 'dist', 'bundle.js'), 'console.log(1)\n');
    await writeFile(join(dir, '.env'), 'API_KEY=secret\n');

    const init = spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    expect(init.status).toBe(0);
    spawnSync('git', ['add', '.gitignore', 'src/app.ts', 'docs/guide.md'], { cwd: dir, stdio: 'ignore' });

    const entries = await listWorkspaceEntries(dir, 200);
    const byPath = new Map(entries.map(item => [item.path, item]));

    expect(byPath.get('src/')).toEqual({ path: 'src/', kind: 'dir', ignored: false });
    expect(byPath.get('src/app.ts')).toEqual({ path: 'src/app.ts', kind: 'file', ignored: false });
    // Shared directory with tracked child stays non-ignored while ignored subdir is flagged.
    expect(byPath.get('docs/')).toEqual({ path: 'docs/', kind: 'dir', ignored: false });
    expect(byPath.get('docs/screenshots/')).toEqual({ path: 'docs/screenshots/', kind: 'dir', ignored: true });
    expect(byPath.get('docs/screenshots/home.png')).toEqual({ path: 'docs/screenshots/home.png', kind: 'file', ignored: true });
    expect(byPath.get('dist/')).toEqual({ path: 'dist/', kind: 'dir', ignored: true });
    expect(byPath.get('dist/bundle.js')).toEqual({ path: 'dist/bundle.js', kind: 'file', ignored: true });
    expect(byPath.get('.env')).toEqual({ path: '.env', kind: 'file', ignored: true });

    expect(filterWorkspaceEntries(entries, '.env', 5).map(e => e.path)).toContain('.env');
    expect(filterWorkspaceEntries(entries, 'screenshots', 5).map(e => e.path)[0]).toBe('docs/screenshots/');

    const preview = await listDirectoryEntriesPreview(dir, 'docs/');
    expect(preview.path).toBe('docs/');
    expect(preview.entries).toEqual([
      { name: 'screenshots', path: 'docs/screenshots/', kind: 'dir', ignored: true },
      { name: 'guide.md', path: 'docs/guide.md', kind: 'file', ignored: false },
    ]);

    const dirResources = await loadDirectorySummaryResources(dir, ['docs/']);
    expect(dirResources).toHaveLength(1);
    expect(dirResources[0]?.text).toContain('Directory docs/ (2 items):');
    expect(dirResources[0]?.text).toContain('- screenshots/ [gitignored]');
    expect(dirResources[0]?.text).toContain('- guide.md');

    expect(formatPromptWithAttachments('inspect workspace', ['.env'], ['src/', 'docs/screenshots/']))
      .toBe('@.env @src/ @docs/screenshots/\n\ninspect workspace');

    const targeted = await searchWorkspacePrefix(dir, 'docs/screenshots/', 50);
    expect(targeted.map(e => e.path)).toContain('docs/screenshots/home.png');
    expect(targeted.find(e => e.path === 'docs/screenshots/home.png')?.ignored).toBe(true);
    expect(await searchWorkspacePrefix(dir, '../etc/passwd', 50)).toEqual([]);
  });

  test('reads clipboard PNG image safely and enforces size and missing-type errors', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const loaded = await readClipboardImage({
      platform: 'linux',
      hasCommand: cmd => cmd === 'wl-paste',
      exec: async (_cmd, args) => {
        if (args.includes('--list-types')) return Buffer.from('text/plain\nimage/png\n');
        if (args.includes('image/png')) return pngBytes;
        return undefined;
      },
    });
    expect(loaded.mimeType).toBe('image/png');
    expect(loaded.size).toBe(pngBytes.byteLength);
    expect(loaded.data).toBe(pngBytes.toString('base64'));
    expect(loaded.path).toMatch(/^clipboard-.*\.png$/);

    await expect(readClipboardImage({
      platform: 'linux',
      hasCommand: cmd => cmd === 'xclip',
      exec: async () => Buffer.from('UTF8_STRING\ntext/plain\n'),
    })).rejects.toThrow('Clipboard does not contain a PNG, JPEG, or WebP image.');

    const macLoaded = await readClipboardImage({
      platform: 'darwin',
      hasCommand: cmd => cmd === 'pngpaste',
      exec: async (cmd, args) => (cmd === 'pngpaste' && args[0] === '-' ? pngBytes : undefined),
    });
    expect(macLoaded.mimeType).toBe('image/png');
    expect(macLoaded.size).toBe(pngBytes.byteLength);
    expect(macLoaded.data).toBe(pngBytes.toString('base64'));

    await expect(readClipboardImage({
      platform: 'darwin',
      hasCommand: () => false,
    })).rejects.toThrow('install pngpaste');

    const macOsaLoaded = await readClipboardImage({
      platform: 'darwin',
      hasCommand: cmd => cmd === 'osascript',
      exec: async cmd => (cmd === 'osascript' ? Buffer.from(pngBytes.toString('base64')) : undefined),
    });
    expect(macOsaLoaded.mimeType).toBe('image/png');
    expect(macOsaLoaded.data).toBe(pngBytes.toString('base64'));

    const dir = await tempDir();
    const uriImgPath = join(dir, 'copied-from-nautilus.png');
    await writeFile(uriImgPath, pngBytes);
    const uriLoaded = await readClipboardImage({
      cwd: dir,
      platform: 'linux',
      waylandDisplay: 'wayland-0',
      hasCommand: cmd => cmd === 'wl-paste',
      exec: async (_cmd, args) => {
        if (args.includes('--list-types')) return Buffer.from('text/uri-list\ntext/plain\n');
        if (args.includes('text/uri-list')) return Buffer.from(`# comment\nfile://${uriImgPath}\r\n`);
        return undefined;
      },
    });
    expect(uriLoaded.mimeType).toBe('image/png');
    expect(uriLoaded.data).toBe(pngBytes.toString('base64'));

    const paramMimeLoaded = await readClipboardImage({
      platform: 'linux',
      waylandDisplay: 'wayland-0',
      hasCommand: cmd => cmd === 'wl-paste',
      exec: async (_cmd, args) => {
        if (args.includes('--list-types')) return Buffer.from('image/png;charset=binary\n');
        if (args.includes('image/png;charset=binary')) return pngBytes;
        return undefined;
      },
    });
    expect(paramMimeLoaded.mimeType).toBe('image/png');

    await expect(readClipboardImage({
      platform: 'linux',
      waylandDisplay: 'wayland-0',
      hasCommand: () => false,
    })).rejects.toThrow('wl-clipboard');

    const clipText = await readClipboardText({
      platform: 'linux',
      waylandDisplay: 'wayland-0',
      hasCommand: cmd => cmd === 'wl-paste',
      exec: async cmd => (cmd === 'wl-paste' ? Buffer.from('hello from clipboard') : undefined),
    });
    expect(clipText).toBe('hello from clipboard');
  });

  test('inserts, highlights, formats, and removes inline attachment tokens without duplicating context', () => {
    const mention = atMentionQuery('check @src/u here', 12)!;
    const replaced = replaceAtMentionWithInlineToken(
      { text: 'check @src/u here', cursor: 12 },
      mention,
      inlineAttachmentToken('src/ui.tsx', 'file'),
    );
    expect(replaced).toEqual({ text: 'check @src/ui.tsx here', cursor: 18 });

    const withImg = insertInlineTokenAtCursor(replaced, inlineAttachmentToken('clip-1.png', 'image'));
    expect(withImg.text).toBe('check @src/ui.tsx [Image: clip-1.png] here');

    const decor = extractInlineReferenceDecor(
      withImg.text,
      ['src/ui.tsx'],
      [],
      [{ path: 'clip-1.png' }],
    );
    expect(decor).toEqual([
      { from: 6, to: 17, s: 'accent' },
      { from: 18, to: 37, s: 'info' },
    ]);

    expect(formatPromptWithAttachments('check @src/ui.tsx now', ['src/ui.tsx'], ['src/'])).toBe(
      '@src/\n\ncheck @src/ui.tsx now',
    );
    expect(formatPromptWithAttachments('check @src/ui.tsx in @src/', ['src/ui.tsx'], ['src/'])).toBe(
      'check @src/ui.tsx in @src/',
    );

    const removed = removeInlineToken(withImg, inlineAttachmentToken('src/ui.tsx', 'file'));
    expect(removed.text).toBe('check [Image: clip-1.png] here');
  });

  test('stages, unstages, and discards git changes cleanly while blocking workspace escapes', async () => {
    const dir = await tempDir();
    spawnSync('git', ['init'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    await writeFile(join(dir, 'tracked.txt'), 'v1\n', 'utf8');
    spawnSync('git', ['add', 'tracked.txt'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });

    await writeFile(join(dir, 'tracked.txt'), 'v2\n', 'utf8');
    await writeFile(join(dir, 'scratch.txt'), 'temp\n', 'utf8');

    const before = await detectGitStatus(dir);
    expect(before.find(entry => entry.path === 'tracked.txt')).toMatchObject({ staged: false, unstaged: true });

    await stageGitPath(dir, 'tracked.txt');
    const staged = await detectGitStatus(dir);
    expect(staged.find(entry => entry.path === 'tracked.txt')).toMatchObject({ staged: true, unstaged: false });

    await unstageGitPath(dir, 'tracked.txt');
    const unstaged = await detectGitStatus(dir);
    expect(unstaged.find(entry => entry.path === 'tracked.txt')).toMatchObject({ staged: false, unstaged: true });

    await discardGitPath(dir, 'tracked.txt', 'M');
    await discardGitPath(dir, 'scratch.txt', '?');
    expect(await detectGitStatus(dir)).toEqual([]);

    await expect(stageGitPath(dir, '../outside.txt')).rejects.toThrow('active workspace');
    await expect(discardGitPath(dir, '-rf', '?')).rejects.toThrow('active workspace');
  });
});
