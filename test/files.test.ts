import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atMentionQuery,
  filterWorkspaceFiles,
  formatPromptWithAttachments,
  imageMimeType,
  listWorkspaceFiles,
  loadEmbeddedResourceAttachments,
  readGitFileDiff,
  readImageAttachment,
  readWorkspaceTextPreview,
  resolvePastedImagePath,
  stripAtMention,
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
  });

  test('prepends attached file chips cleanly to prompt text', () => {
    expect(formatPromptWithAttachments('Explain this', [])).toBe('Explain this');
    expect(formatPromptWithAttachments('Explain this', ['src/ui.tsx', 'package.json'])).toBe(
      '@src/ui.tsx @package.json\n\nExplain this',
    );
  });

  test('walks directory while skipping ignored directories when not a git repo', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'README.md'), 'hi');
    await writeFile(join(dir, 'src', 'app.ts'), 'export {}');
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
    const files = await listWorkspaceFiles(dir);
    expect(files).toEqual(['README.md', 'src/app.ts']);
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
});
