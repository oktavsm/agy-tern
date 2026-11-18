import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CURRENT_VERSION,
  checkForUpdatePassive,
  compareSemver,
  detectInstallLocation,
  extractTagFromReleaseUrl,
  normalizeTag,
  parseSha256Sums,
  resolveLatestTag,
  runSelfUpdate,
  sha256Hex,
  type FetchLike,
} from '../src/updater';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-tern-updater-'));
  tempDirs.push(dir);
  return dir;
}

async function makeReleaseTarball(versionTag: string): Promise<{ archiveBytes: Uint8Array; sumsText: string; archiveName: string }> {
  const root = makeTempDir();
  const folderName = `agy-tern-${versionTag}`;
  const pkgDir = join(root, folderName);
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'agy-tern', version: versionTag.replace(/^v/, '') }));
  writeFileSync(join(pkgDir, 'dist', 'cli.js'), `#!/usr/bin/env bun\nconsole.log('${versionTag}');\n`);

  const archiveName = `agy-tern-${versionTag}.tar.gz`;
  const archivePath = join(root, archiveName);
  await execFileAsync('tar', ['-czf', archivePath, '-C', root, folderName]);
  const archiveBytes = new Uint8Array(readFileSync(archivePath));
  const digest = sha256Hex(archiveBytes);
  return { archiveBytes, sumsText: `${digest}  ${archiveName}\n`, archiveName };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('updater', () => {
  test('normalizes and compares semver tags including prereleases', () => {
    expect(normalizeTag('0.2.0')).toBe('v0.2.0');
    expect(normalizeTag('v0.2.1-rc.1')).toBe('v0.2.1-rc.1');
    expect(() => normalizeTag('not-a-version')).toThrow('Invalid release version/tag');

    expect(compareSemver('0.1.0', 'v0.1.0')).toBe(0);
    expect(compareSemver('v0.2.0', 'v0.1.9')).toBe(1);
    expect(compareSemver('v0.1.0', 'v0.2.0')).toBe(-1);
    expect(compareSemver('v0.2.0-rc.1', 'v0.2.0')).toBe(-1);
    expect(compareSemver('v0.2.0', 'v0.2.0-rc.1')).toBe(1);
  });

  test('extracts release tags and parses sha256 checksum manifests', () => {
    expect(extractTagFromReleaseUrl('https://github.com/oktavsm/agy-tern/releases/tag/v0.2.0')).toBe('v0.2.0');
    expect(extractTagFromReleaseUrl('https://github.com/oktavsm/agy-tern/releases/tag/0.3.1?foo=bar')).toBe('v0.3.1');
    expect(extractTagFromReleaseUrl('https://github.com/oktavsm/agy-tern/releases')).toBeUndefined();

    const manifest = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  other.tar.gz',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *dist/agy-tern-v0.2.0.tar.gz',
    ].join('\n');
    expect(parseSha256Sums(manifest, 'agy-tern-v0.2.0.tar.gz')).toBe('b'.repeat(64));
    expect(parseSha256Sums(manifest, 'missing.tar.gz')).toBeUndefined();
  });

  test('detects git vs standalone release installs even across symlinks', () => {
    const base = makeTempDir();
    const gitRoot = join(base, 'repo');
    mkdirSync(join(gitRoot, '.git'), { recursive: true });
    mkdirSync(join(gitRoot, 'dist'), { recursive: true });
    writeFileSync(join(gitRoot, 'package.json'), '{"name":"agy-tern"}');
    writeFileSync(join(gitRoot, 'dist', 'cli.js'), '');
    const gitLink = join(base, 'bin-git');
    symlinkSync(join(gitRoot, 'dist', 'cli.js'), gitLink);

    expect(detectInstallLocation(gitLink, join(base, 'data'))).toEqual({ kind: 'git', rootDir: gitRoot });

    const relRoot = join(base, 'data', 'current');
    mkdirSync(join(relRoot, 'dist'), { recursive: true });
    writeFileSync(join(relRoot, 'package.json'), '{"name":"agy-tern"}');
    writeFileSync(join(relRoot, 'dist', 'cli.js'), '');
    const relLink = join(base, 'bin-rel');
    symlinkSync(join(relRoot, 'dist', 'cli.js'), relLink);

    expect(detectInstallLocation(relLink, join(base, 'data'))).toEqual({
      kind: 'release',
      rootDir: relRoot,
      dataDir: join(base, 'data'),
    });
  });

  test('resolves latest release tag via redirect URL and falls back to REST API', async () => {
    const redirectFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain('/releases/latest');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        url: 'https://github.com/oktavsm/agy-tern/releases/tag/v0.2.5',
      } as Response;
    }) as FetchLike;

    expect(await resolveLatestTag({ fetchFn: redirectFetch })).toBe('v0.2.5');

    let calls = 0;
    const apiFallbackFetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          url: 'https://github.com/oktavsm/agy-tern/releases',
        } as Response;
      }
      return new Response(JSON.stringify({ tag_name: 'v0.3.0' }), { status: 200 });
    }) as FetchLike;

    expect(await resolveLatestTag({ fetchFn: apiFallbackFetch })).toBe('v0.3.0');
  });

  test('runs release self-update with SHA-256 check, atomic swap, and rejects bad digests', async () => {
    const base = makeTempDir();
    const dataDir = join(base, 'share', 'agy-tern');
    const binDir = join(base, 'bin');
    const currentDir = join(dataDir, 'current');
    mkdirSync(join(currentDir, 'dist'), { recursive: true });
    writeFileSync(join(currentDir, 'package.json'), JSON.stringify({ name: 'agy-tern', version: CURRENT_VERSION }));
    writeFileSync(join(currentDir, 'dist', 'cli.js'), 'console.log("old");\n');

    const { archiveBytes, sumsText, archiveName } = await makeReleaseTarball('v9.9.9');
    const goodFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'HEAD' || url.endsWith('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          url: 'https://github.com/oktavsm/agy-tern/releases/tag/v9.9.9',
        } as Response;
      }
      if (url.endsWith(`/${archiveName}`)) {
        return new Response(Buffer.from(archiveBytes), { status: 200 });
      }
      if (url.endsWith('/SHA256SUMS.txt')) {
        return new Response(sumsText, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    }) as FetchLike;

    const logs: string[] = [];
    const checkResult = await runSelfUpdate({
      checkOnly: true,
      entryPath: join(currentDir, 'dist', 'cli.js'),
      dataDir,
      binDir,
      fetchFn: goodFetch,
      log: line => logs.push(line),
    });
    expect(checkResult).toEqual({
      updated: false,
      fromVersion: normalizeTag(CURRENT_VERSION),
      toVersion: 'v9.9.9',
      mode: 'release',
    });
    expect(logs.some(line => line.includes('Update available'))).toBe(true);

    const badFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/SHA256SUMS.txt')) {
        return new Response(`${'0'.repeat(64)}  ${archiveName}\n`, { status: 200 });
      }
      return goodFetch(input, init);
    }) as FetchLike;

    await expect(runSelfUpdate({
      entryPath: join(currentDir, 'dist', 'cli.js'),
      dataDir,
      binDir,
      fetchFn: badFetch,
      log: () => {},
    })).rejects.toThrow('Checksum verification failed');
    // Failed checksum leaves existing installation untouched.
    expect(readFileSync(join(currentDir, 'dist', 'cli.js'), 'utf8')).toContain('old');

    const updateLogs: string[] = [];
    const updateResult = await runSelfUpdate({
      entryPath: join(currentDir, 'dist', 'cli.js'),
      dataDir,
      binDir,
      fetchFn: goodFetch,
      log: line => updateLogs.push(line),
    });
    expect(updateResult).toEqual({
      updated: true,
      fromVersion: normalizeTag(CURRENT_VERSION),
      toVersion: 'v9.9.9',
      mode: 'release',
    });
    expect(readFileSync(join(currentDir, 'dist', 'cli.js'), 'utf8')).toContain('v9.9.9');
    const launcher = join(binDir, 'agy-tern');
    expect(lstatSync(launcher).isSymbolicLink()).toBe(true);
    expect(readlinkSync(launcher)).toBe(join(currentDir, 'dist', 'cli.js'));
    expect(existsSync(join(dataDir, 'current', 'package.json'))).toBe(true);
  });

  test('caches passive startup update checks for 24h and respects opt-out env vars', async () => {
    const dir = makeTempDir();
    const cachePath = join(dir, 'state', 'update-check.json');
    const prevCi = process.env.CI;
    const prevNoCheck = process.env.AGY_TERN_NO_UPDATE_CHECK;
    delete process.env.CI;
    delete process.env.AGY_TERN_NO_UPDATE_CHECK;

    try {
      let fetchCalls = 0;
      const mockFetch: FetchLike = async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          url: 'https://github.com/oktavsm/agy-tern/releases/tag/v9.9.9',
        } as Response;
      };

      const t0 = 1_700_000_000_000;
      const first = await checkForUpdatePassive({ cachePath, now: t0, fetchFn: mockFetch });
      expect(first).toEqual({
        currentVersion: normalizeTag(CURRENT_VERSION),
        latestTag: 'v9.9.9',
        updateAvailable: true,
      });
      expect(fetchCalls).toBe(1);

      // Within 24h TTL uses cache and avoids remote request.
      const cached = await checkForUpdatePassive({ cachePath, now: t0 + 60_000, fetchFn: mockFetch });
      expect(cached?.latestTag).toBe('v9.9.9');
      expect(fetchCalls).toBe(1);

      // Past 24h TTL refreshes remote check.
      const refreshed = await checkForUpdatePassive({ cachePath, now: t0 + 25 * 60 * 60 * 1000, fetchFn: mockFetch });
      expect(refreshed?.latestTag).toBe('v9.9.9');
      expect(fetchCalls).toBe(2);

      process.env.AGY_TERN_NO_UPDATE_CHECK = '1';
      expect(await checkForUpdatePassive({ cachePath, now: t0 + 50 * 60 * 60 * 1000, fetchFn: mockFetch })).toBeUndefined();
      expect(fetchCalls).toBe(2);
    } finally {
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
      if (prevNoCheck === undefined) delete process.env.AGY_TERN_NO_UPDATE_CHECK;
      else process.env.AGY_TERN_NO_UPDATE_CHECK = prevNoCheck;
    }
  });
});
