import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pkg from '../package.json';

const execFileAsync = promisify(execFile);

export const DEFAULT_GITHUB_REPO = 'oktavsm/agy-tern';
export const CURRENT_VERSION: string = pkg.version;

const VALID_TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PASSIVE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export type InstallLocation =
  | { kind: 'git'; rootDir: string }
  | { kind: 'release'; rootDir: string; dataDir: string };

export interface UpdateCheckResult {
  currentVersion: string;
  latestTag: string;
  updateAvailable: boolean;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SelfUpdateOptions {
  checkOnly?: boolean;
  force?: boolean;
  targetVersion?: string;
  repo?: string;
  entryPath?: string;
  binDir?: string;
  dataDir?: string;
  fetchFn?: FetchLike;
  log?: (line: string) => void;
}

export function normalizeTag(raw: string): string {
  const trimmed = raw.trim();
  if (!VALID_TAG_RE.test(trimmed)) {
    throw new Error(`Invalid release version/tag "${raw}". Expected semver such as v0.2.0.`);
  }
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/** Compare two semver strings (with optional leading "v"). Returns -1, 0, or 1. */
export function compareSemver(aRaw: string, bRaw: string): -1 | 0 | 1 {
  const clean = (input: string): { nums: [number, number, number]; pre: string } => {
    const bare = input.trim().replace(/^v/i, '');
    const [core = '0.0.0', pre = ''] = bare.split('-', 2);
    const parts = core.split('.').map(part => Number.parseInt(part, 10) || 0);
    return { nums: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre };
  };
  const a = clean(aRaw);
  const b = clean(bRaw);
  for (let i = 0; i < 3; i++) {
    if (a.nums[i]! < b.nums[i]!) return -1;
    if (a.nums[i]! > b.nums[i]!) return 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** Extract tag name from a redirected GitHub `/releases/tag/<tag>` URL. */
export function extractTagFromReleaseUrl(url: string): string | undefined {
  const marker = '/releases/tag/';
  const idx = url.indexOf(marker);
  if (idx < 0) return undefined;
  const raw = decodeURIComponent(url.slice(idx + marker.length).split(/[?#]/, 1)[0] ?? '').trim();
  return VALID_TAG_RE.test(raw) ? normalizeTag(raw) : undefined;
}

/** Parse standard `sha256sum` output to look up the expected hex digest for `filename`. */
export function parseSha256Sums(content: string, filename: string): string | undefined {
  const target = basename(filename);
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;
    if (basename(match[2]!.trim()) === target) {
      return match[1]!.toLowerCase();
    }
  }
  return undefined;
}

export function sha256Hex(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex').toLowerCase();
}

export function defaultDataDir(): string {
  const xdgData = process.env.XDG_DATA_HOME;
  return resolve(
    xdgData && isAbsolute(xdgData) ? xdgData : join(homedir(), '.local', 'share'),
    'agy-tern',
  );
}

export function defaultBinDir(): string {
  const xdgBin = process.env.XDG_BIN_HOME;
  return resolve(xdgBin && isAbsolute(xdgBin) ? xdgBin : join(homedir(), '.local', 'bin'));
}

function defaultUpdateCachePath(): string {
  const xdgState = process.env.XDG_STATE_HOME;
  const base = resolve(xdgState && isAbsolute(xdgState) ? xdgState : join(homedir(), '.local', 'state'), 'agy-tern');
  return join(base, 'update-check.json');
}

/** Determine whether the active binary runs from a git checkout or a standalone release directory. */
export function detectInstallLocation(entryPath = process.argv[1], dataDir = defaultDataDir()): InstallLocation {
  const rawEntry = entryPath ? resolve(entryPath) : resolve(process.cwd(), 'dist', 'cli.js');
  let resolvedEntry = rawEntry;
  try {
    resolvedEntry = realpathSync(rawEntry);
  } catch {
    // Entry file may not exist in unit tests or transient swaps; fall back to path.resolve.
  }
  let cursor = dirname(resolvedEntry);
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(cursor, 'package.json'))) {
      if (existsSync(join(cursor, '.git'))) {
        return { kind: 'git', rootDir: cursor };
      }
      return { kind: 'release', rootDir: cursor, dataDir: resolve(dataDir) };
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { kind: 'release', rootDir: resolve(dataDir, 'current'), dataDir: resolve(dataDir) };
}

/** Resolve the latest published GitHub Release tag without hitting unauthenticated REST rate limits. */
export async function resolveLatestTag(opts?: {
  repo?: string;
  fetchFn?: FetchLike;
  signal?: AbortSignal;
}): Promise<string> {
  const repo = opts?.repo ?? DEFAULT_GITHUB_REPO;
  const fetchFn = opts?.fetchFn ?? fetch;
  const latestUrl = `https://github.com/${repo}/releases/latest`;
  const response = await fetchFn(latestUrl, {
    method: 'HEAD',
    redirect: 'follow',
    signal: opts?.signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to check latest release (${response.status} ${response.statusText}).`);
  }
  const fromUrl = extractTagFromReleaseUrl(response.url);
  if (fromUrl) return fromUrl;

  const apiResp = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `agy-tern/${CURRENT_VERSION}` },
    signal: opts?.signal,
  });
  if (!apiResp.ok) {
    throw new Error(`Could not resolve latest release tag from ${latestUrl}.`);
  }
  const payload = await apiResp.json() as { tag_name?: unknown };
  if (typeof payload.tag_name !== 'string') {
    throw new Error('GitHub latest release response did not include tag_name.');
  }
  return normalizeTag(payload.tag_name);
}

function linkLauncher(targetCli: string, binDir: string, force: boolean): string {
  mkdirSync(binDir, { recursive: true });
  chmodSync(targetCli, 0o755);
  const linkPath = join(binDir, 'agy-tern');
  try {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      const existing = readlinkSync(linkPath);
      const resolvedExisting = isAbsolute(existing) ? existing : resolve(binDir, existing);
      if (resolvedExisting === targetCli) return linkPath;
      unlinkSync(linkPath);
    } else if (force) {
      rmSync(linkPath, { force: true });
    } else {
      throw new Error(`${linkPath} exists and is not a symlink. Re-run with --force to replace it.`);
    }
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
  }
  symlinkSync(targetCli, linkPath);
  return linkPath;
}

/** Update or check updates for standalone release or git-checkout installations. */
export async function runSelfUpdate(opts?: SelfUpdateOptions): Promise<{
  updated: boolean;
  fromVersion: string;
  toVersion: string;
  mode: 'git' | 'release';
}> {
  const log = opts?.log ?? ((line: string) => console.log(line));
  const repo = opts?.repo ?? DEFAULT_GITHUB_REPO;
  const fetchFn = opts?.fetchFn ?? fetch;
  const location = detectInstallLocation(opts?.entryPath, opts?.dataDir);
  const currentTag = normalizeTag(CURRENT_VERSION);

  if (location.kind === 'git') {
    if (opts?.checkOnly) {
      const latestTag = opts.targetVersion ? normalizeTag(opts.targetVersion) : await resolveLatestTag({ repo, fetchFn });
      const available = compareSemver(latestTag, currentTag) > 0;
      log(available
        ? `Update available: ${currentTag} -> ${latestTag} (git checkout at ${location.rootDir}; run git pull && bun run build or agy-tern update).`
        : `agy-tern is up to date (${currentTag}, git checkout at ${location.rootDir}).`);
      return { updated: false, fromVersion: currentTag, toVersion: latestTag, mode: 'git' };
    }
    const { stdout: dirty } = await execFileAsync('git', ['status', '--porcelain'], { cwd: location.rootDir });
    if (dirty.trim()) {
      throw new Error(`Git checkout at ${location.rootDir} has local uncommitted changes. Commit or stash them before running agy-tern update.`);
    }
    log(`Updating git checkout at ${location.rootDir}...`);
    await execFileAsync('git', ['pull', '--ff-only'], { cwd: location.rootDir });
    await execFileAsync('bun', ['install', '--frozen-lockfile'], { cwd: location.rootDir });
    await execFileAsync('bun', ['run', 'build'], { cwd: location.rootDir });
    const updatedPkg = JSON.parse(readFileSync(join(location.rootDir, 'package.json'), 'utf8')) as { version?: string };
    const nextTag = updatedPkg.version ? normalizeTag(updatedPkg.version) : currentTag;
    log(`Updated git checkout: ${currentTag} -> ${nextTag}.`);
    return { updated: true, fromVersion: currentTag, toVersion: nextTag, mode: 'git' };
  }

  const targetTag = opts?.targetVersion ? normalizeTag(opts.targetVersion) : await resolveLatestTag({ repo, fetchFn });
  const isNewer = compareSemver(targetTag, currentTag) > 0;
  if (opts?.checkOnly) {
    log(isNewer
      ? `Update available: ${currentTag} -> ${targetTag}. Run \`agy-tern update\` to install.`
      : `agy-tern is up to date (${currentTag}).`);
    return { updated: false, fromVersion: currentTag, toVersion: targetTag, mode: 'release' };
  }
  if (!isNewer && !opts?.force && !opts?.targetVersion) {
    log(`agy-tern is already at the latest version (${currentTag}).`);
    return { updated: false, fromVersion: currentTag, toVersion: targetTag, mode: 'release' };
  }

  const archiveName = `agy-tern-${targetTag}.tar.gz`;
  const baseUrl = `https://github.com/${repo}/releases/download/${targetTag}`;
  log(`Downloading ${archiveName}...`);
  const [archiveResp, sumsResp] = await Promise.all([
    fetchFn(`${baseUrl}/${archiveName}`, { redirect: 'follow' }),
    fetchFn(`${baseUrl}/SHA256SUMS.txt`, { redirect: 'follow' }),
  ]);
  if (!archiveResp.ok) {
    throw new Error(`Failed to download ${archiveName} (${archiveResp.status} ${archiveResp.statusText}).`);
  }
  if (!sumsResp.ok) {
    throw new Error(`Failed to download SHA256SUMS.txt (${sumsResp.status} ${sumsResp.statusText}).`);
  }
  const archiveBytes = new Uint8Array(await archiveResp.arrayBuffer());
  const sumsText = await sumsResp.text();
  const expectedSha = parseSha256Sums(sumsText, archiveName);
  if (!expectedSha) {
    throw new Error(`SHA256SUMS.txt does not contain an entry for ${archiveName}.`);
  }
  const actualSha = sha256Hex(archiveBytes);
  if (actualSha !== expectedSha) {
    throw new Error(`Checksum verification failed for ${archiveName} (expected ${expectedSha}, got ${actualSha}).`);
  }

  const dataDir = location.dataDir;
  mkdirSync(dataDir, { recursive: true });
  const stageDir = join(dataDir, `.staging-${randomUUID()}`);
  const archiveFile = join(stageDir, archiveName);
  const extractDir = join(stageDir, 'extract');
  const currentDir = join(dataDir, 'current');
  const backupDir = join(dataDir, `.backup-${randomUUID()}`);

  try {
    mkdirSync(extractDir, { recursive: true });
    writeFileSync(archiveFile, archiveBytes);
    await execFileAsync('tar', ['-xzf', archiveFile, '-C', extractDir]);

    const entries = readdirSync(extractDir);
    const extractedRoot = entries.length === 1 && existsSync(join(extractDir, entries[0]!, 'dist', 'cli.js'))
      ? join(extractDir, entries[0]!)
      : extractDir;
    if (!existsSync(join(extractedRoot, 'dist', 'cli.js')) || !existsSync(join(extractedRoot, 'package.json'))) {
      throw new Error(`Downloaded archive ${archiveName} is missing dist/cli.js or package.json.`);
    }

    if (existsSync(currentDir)) {
      renameSync(currentDir, backupDir);
    }
    try {
      renameSync(extractedRoot, currentDir);
    } catch (swapErr) {
      if (existsSync(backupDir) && !existsSync(currentDir)) {
        try { renameSync(backupDir, currentDir); } catch {}
      }
      throw swapErr;
    }
    if (existsSync(backupDir)) {
      rmSync(backupDir, { recursive: true, force: true });
    }
    const binDir = opts?.binDir ?? defaultBinDir();
    const linkPath = linkLauncher(join(currentDir, 'dist', 'cli.js'), binDir, Boolean(opts?.force));
    log(`Updated agy-tern: ${currentTag} -> ${targetTag}`);
    log(`Installed at ${currentDir} (linked ${linkPath}).`);
    return { updated: true, fromVersion: currentTag, toVersion: targetTag, mode: 'release' };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/** Throttled (once per 24h) non-blocking startup check returning update info when a newer release exists. */
export async function checkForUpdatePassive(opts?: {
  repo?: string;
  cachePath?: string;
  now?: number;
  fetchFn?: FetchLike;
}): Promise<UpdateCheckResult | undefined> {
  if (process.env.CI || process.env.AGY_TERN_NO_UPDATE_CHECK === '1') return undefined;
  const cachePath = opts?.cachePath ?? defaultUpdateCachePath();
  const now = opts?.now ?? Date.now();
  const currentTag = normalizeTag(CURRENT_VERSION);

  let cachedTag: string | undefined;
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as { checkedAt?: number; latestTag?: string };
    if (
      typeof parsed?.checkedAt === 'number' &&
      now - parsed.checkedAt < PASSIVE_CHECK_TTL_MS &&
      typeof parsed.latestTag === 'string' &&
      VALID_TAG_RE.test(parsed.latestTag)
    ) {
      cachedTag = normalizeTag(parsed.latestTag);
      const available = compareSemver(cachedTag, currentTag) > 0;
      return available ? { currentVersion: currentTag, latestTag: cachedTag, updateAvailable: true } : undefined;
    }
  } catch {
    // Missing or invalid cache falls through to a bounded remote check.
  }

  try {
    const latestTag = await resolveLatestTag({
      repo: opts?.repo,
      fetchFn: opts?.fetchFn,
      signal: AbortSignal.timeout(3_000),
    });
    await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
    const tmp = `${cachePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify({ checkedAt: now, latestTag }), { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(tmp, cachePath);
    } finally {
      await rm(tmp, { force: true });
    }
    return compareSemver(latestTag, currentTag) > 0
      ? { currentVersion: currentTag, latestTag, updateAvailable: true }
      : undefined;
  } catch {
    return undefined;
  }
}
