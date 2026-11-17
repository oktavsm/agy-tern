import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import {
  blobId,
  concatBytes,
  DEFAULT_APC,
  DEFAULT_CREDITS,
  isJsonObject,
  KINDS,
  PROTOCOL_VERSION,
  splitMessage,
  TERMINAL_FEATURES,
  type CellSize,
  type CloseMessage,
  type FormValues,
  type FrameMessage,
  type HelloReply,
  type Json,
  type JsonObject,
  type Kind,
  type Mod,
  type Op,
  type OpenMessage,
  type Query,
  type RegionName,
  type RevealAt,
  type ScrollTo,
  type StylesheetMessage,
  type SurfaceFont,
  type SurfaceMode,
  type TerminalFeature,
  type WireNode,
} from '@stencil-hq/tern';

export const VALID_KINDS: ReadonlySet<string> = new Set<string>(KINDS);

export const VALID_TONES: ReadonlySet<string> = new Set<string>([
  'neutral',
  'accent',
  'info',
  'success',
  'warning',
  'error',
  'pending',
  'muted',
  'user',
]);

export const VALID_SPAN_TOKENS: ReadonlySet<string> = new Set<string>([
  'muted',
  'dim',
  'strong',
  'em',
  'accent',
  'success',
  'warning',
  'error',
  'info',
  'pending',
  'code',
  'mono',
  'path',
  'key',
  'link',
  'num',
  'ins',
  'del',
  'mark',
  'typo',
  'icon',
  'hide',
  'title',
]);

export interface TspIsolatedEnvLike {
  readonly workspace: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface TspLaunchOptions {
  /** Path to mock or real agy binary passed via `--agy` (required unless `args` overrides full invocation). */
  readonly agyPath?: string;
  /** Workspace directory passed as PTY bridge cwd (defaults to isolatedEnv.workspace or process.cwd()). */
  readonly cwd?: string;
  /** Optional isolated env created by `createIsolatedEnv()`. */
  readonly isolatedEnv?: TspIsolatedEnvLike;
  /** Extra CLI flags passed to `src/cli.tsx` after `--agy <agyPath>`. */
  readonly args?: readonly string[];
  /** Environment variables merged onto sanitized parent env (`TERN_TSP`, `TMUX`, `STY`, `ZELLIJ` stripped by default). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Initial PTY width (default 120). */
  readonly cols?: number;
  /** Initial PTY height (default 40). */
  readonly rows?: number;
  /** Simulated cell pixel size in hello reply (default `{ w: 8, h: 16 }`). */
  readonly cell?: CellSize;
  /** Initial dark theme capability (default `true`). */
  readonly dark?: boolean;
  /** Initial reduceMotion capability (default `false`). */
  readonly reduceMotion?: boolean;
  /** Initial hour12 capability (default `false`). */
  readonly hour12?: boolean;
  /** Override advertised `hello` APC limit (default `DEFAULT_APC = 65536`). */
  readonly apc?: number;
  /** Override advertised `hello` credits (default `DEFAULT_CREDITS = 2`). */
  readonly credits?: number;
  /** Override advertised terminal features (default `[...TERMINAL_FEATURES]`). */
  readonly features?: readonly TerminalFeature[];
  /** Override advertised kinds (default `[...KINDS]`). */
  readonly kinds?: readonly string[];
  /** Auto-ack incoming `f` frames immediately (default `true`). */
  readonly autoAck?: boolean;
  /** Handshake timeout in ms for `launch()` (default `5000`). */
  readonly handshakeTimeoutMs?: number;
  /** Entrypoint script relative to repo root (default `'src/cli.tsx'`). */
  readonly cliEntry?: string;
}

export interface TspNode {
  readonly id: string;
  readonly k: string;
  readonly p: Record<string, Json>;
  readonly c: TspNode[];
}

export interface TspRegions {
  main: TspNode | null;
  dock: TspNode | null;
  layer: TspNode | null;
}

export type ViewportEffect =
  | { readonly kind: 'reveal'; readonly sf: string; readonly s: number; readonly id: string; readonly at: RevealAt }
  | { readonly kind: 'scroll'; readonly sf: string; readonly s: number; readonly id: string; readonly to: ScrollTo }
  | { readonly kind: 'suspend'; readonly sf: string; readonly s: number }
  | { readonly kind: 'resume'; readonly sf: string; readonly s: number };

export interface SurfaceSnapshot {
  readonly id: string;
  readonly mode: SurfaceMode;
  readonly title?: string;
  readonly role?: string;
  readonly listen: boolean;
  readonly adopt: boolean;
  readonly closable: boolean;
  readonly font: SurfaceFont;
  readonly closed: boolean;
  readonly kept: boolean;
  readonly suspended: boolean;
  readonly focusedId: string | null;
  readonly lastSeq: number;
  readonly ackedSeq: number;
  readonly regions: TspRegions;
  readonly nodes: ReadonlyMap<string, TspNode>;
  readonly settledIds: ReadonlySet<string>;
  readonly stylesheets: ReadonlyMap<string, string>;
  readonly viewportEffects: readonly ViewportEffect[];
}

export interface StoredBlob {
  readonly id: string;
  readonly mime?: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
}

export type WireEventRecord =
  | { readonly ts: number; readonly dir: 'out'; readonly verb: 'q'; readonly body: Query; readonly params: Record<string, string> }
  | { readonly ts: number; readonly dir: 'out'; readonly verb: 'o'; readonly body: OpenMessage; readonly params: Record<string, string> }
  | { readonly ts: number; readonly dir: 'out'; readonly verb: 'f'; readonly body: FrameMessage; readonly params: Record<string, string> }
  | { readonly ts: number; readonly dir: 'out'; readonly verb: 's'; readonly body: StylesheetMessage; readonly params: Record<string, string> }
  | { readonly ts: number; readonly dir: 'out'; readonly verb: 'b'; readonly id: string; readonly mime?: string; readonly byteLength: number; readonly params: Record<string, string> }
  | { readonly ts: number; readonly dir: 'out'; readonly verb: 'x'; readonly body: CloseMessage; readonly params: Record<string, string> }
  | { readonly ts: number; readonly dir: 'in'; readonly verb: 'r'; readonly body: HelloReply | { readonly r: 'blobs'; readonly have: readonly string[] } }
  | { readonly ts: number; readonly dir: 'in'; readonly verb: 'e'; readonly body: Record<string, Json> };

export interface StatusSegmentInfo {
  readonly id: string;
  readonly key: string;
  readonly text: string;
  readonly icon?: string;
  readonly tone?: string;
  readonly side?: string;
  readonly priority?: number;
  readonly title?: string;
}

export interface WaitForReadyOptions {
  readonly timeoutMs?: number;
  /** When `true` (default), waits until `dock.bar.state` leaves Connecting/Syncing state. */
  readonly waitForAgent?: boolean;
  /** When `false` (default), rejects if `dock.bar.state` settles on `Connection failed` or `Disconnected`. */
  readonly allowDisconnected?: boolean;
}

export interface WireInvariantOptions {
  /** Skip literal emoji check on specific node IDs (e.g. `['dock.draft']` during Unicode grapheme tests). */
  readonly allowEmojiInNodeIds?: readonly string[];
  /** Allow `el` nodes if explicitly testing fallback HTML rendering (default `false`: zero `el`). */
  readonly allowEl?: boolean;
}

export interface CloseResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

interface ParsedMessage {
  readonly verb: string;
  readonly params: Record<string, string>;
  readonly body: Uint8Array;
}

interface MutableSurfaceState {
  readonly id: string;
  readonly mode: SurfaceMode;
  readonly title?: string;
  readonly role?: string;
  readonly listen: boolean;
  readonly adopt: boolean;
  readonly closable: boolean;
  readonly font: SurfaceFont;
  closed: boolean;
  kept: boolean;
  suspended: boolean;
  focusedId: string | null;
  lastSeq: number;
  ackedSeq: number;
  readonly regions: TspRegions;
  readonly nodes: Map<string, TspNode>;
  readonly parentOf: Map<string, string>;
  readonly settledIds: Set<string>;
  readonly stylesheets: Map<string, string>;
  readonly viewportEffects: ViewportEffect[];
}

interface BridgeStartedEvent {
  readonly type: 'started';
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
}

interface BridgeDataEvent {
  readonly type: 'data';
  readonly data: string;
}

interface BridgeResizedEvent {
  readonly type: 'resized';
  readonly cols: number;
  readonly rows: number;
  readonly id?: string;
}

interface BridgeRssEvent {
  readonly type: 'rss';
  readonly pid: number;
  readonly kb: number | null;
  readonly id?: string;
}

interface BridgeExitEvent {
  readonly type: 'exit';
  readonly code: number | null;
  readonly signal: string | null;
}

interface BridgeErrorEvent {
  readonly type: 'error';
  readonly message: string;
}

type BridgeEvent =
  | BridgeStartedEvent
  | BridgeDataEvent
  | BridgeResizedEvent
  | BridgeRssEvent
  | BridgeExitEvent
  | BridgeErrorEvent;

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const PTY_BRIDGE_PATH = resolve(import.meta.dir, 'pty_bridge.py');

const STRIPPED_ENV_KEYS = [
  'TERN_TSP',
  'TERN_TSP_RECORD',
  'STY',
  'ZELLIJ',
  'ZELLIJ_SESSION_NAME',
  'TMUX',
  'TMUX_PANE',
] as const;

const APC_TSP = [0x1b, 0x5f, 0x74, 0x73, 0x70, 0x3b] as const; // \x1b_tsp;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u2600-\u26FF\u2700-\u27BF\u2B00-\u2BFF\uFE0F\u20E3]/u;
const EM_DASH_RE = /\u2014/;
const SLOT_KEYS = new Set(['head', 'end', 'foot', 'avatar']);

const encoder = new TextEncoder();

function buildTspEnv(
  isolatedEnv?: TspIsolatedEnvLike,
  overrides?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const base = isolatedEnv ? isolatedEnv.env : process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const key of STRIPPED_ENV_KEYS) {
    delete env[key];
  }
  if (!env['TERM']) env['TERM'] = 'xterm-256color';
  if (!env['COLORTERM']) env['COLORTERM'] = 'truecolor';
  if (!env['LANG']) env['LANG'] = 'C.UTF-8';
  const bunBinDir = dirname(process.execPath);
  if (!env['PATH']) {
    env['PATH'] = bunBinDir;
  } else if (!env['PATH'].split(':').includes(bunBinDir)) {
    env['PATH'] = `${bunBinDir}:${env['PATH']}`;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

class ChunkReassembler {
  private readonly pending = new Map<
    string,
    { readonly verb: string; readonly params: Record<string, string>; readonly parts: Uint8Array[] }
  >();

  push(verb: string, rawParams: readonly (readonly [string, string])[], body: Uint8Array): ParsedMessage | null {
    const cleanParams: Record<string, string> = {};
    let chunkId: string | undefined;
    let more = false;
    for (const [k, v] of rawParams) {
      if (k === 'c') chunkId = v;
      else if (k === 'm') more = v === '1';
      else cleanParams[k] = v;
    }

    if (chunkId === undefined) {
      return { verb, params: cleanParams, body };
    }

    let entry = this.pending.get(chunkId);
    if (!entry) {
      entry = { verb, params: cleanParams, parts: [body] };
      this.pending.set(chunkId, entry);
    } else {
      entry.parts.push(body);
    }

    if (more) return null;
    this.pending.delete(chunkId);
    return { verb: entry.verb, params: entry.params, body: concatBytes(entry.parts) };
  }
}

class TspStreamParser {
  private held: Uint8Array = new Uint8Array(0);
  private collecting: { readonly parts: Uint8Array[]; esc: boolean } | null = null;
  private readonly reassembler = new ChunkReassembler();

  constructor(
    private readonly onMessage: (msg: ParsedMessage) => void,
    private readonly onNonTspBytes: (bytes: Uint8Array) => void,
    private readonly onError: (msg: string) => void,
  ) {}

  feed(chunk: Uint8Array): void {
    const bytes = this.held.length > 0 ? concatBytes([this.held, chunk]) : chunk;
    this.held = new Uint8Array(0);
    let pos = 0;

    while (pos < bytes.length) {
      if (this.collecting) {
        const start = pos;
        let closed = false;
        while (pos < bytes.length) {
          const b = bytes[pos]!;
          if (this.collecting.esc) {
            this.collecting.esc = false;
            if (b === 0x5c) {
              // End of APC: strip trailing 0x1b from previous part or current slice.
              const endInSlice = pos - 1;
              if (endInSlice >= start) {
                this.collecting.parts.push(bytes.subarray(start, endInSlice));
              } else {
                const lastPart = this.collecting.parts.pop();
                if (lastPart && lastPart.length > 1) {
                  this.collecting.parts.push(lastPart.subarray(0, lastPart.length - 1));
                }
              }
              const inner = concatBytes(this.collecting.parts);
              this.collecting = null;
              pos += 1;
              const split = splitMessage(inner);
              if (!split) {
                this.onError('Malformed TSP APC frame without verb');
              } else {
                const assembled = this.reassembler.push(split.verb, split.params, split.body);
                if (assembled) this.onMessage(assembled);
              }
              closed = true;
              break;
            }
          }
          if (b === 0x1b) {
            this.collecting.esc = true;
          }
          pos += 1;
        }
        if (!closed) {
          if (pos > start) {
            this.collecting?.parts.push(bytes.slice(start, pos));
          }
        }
        continue;
      }

      const escIdx = bytes.indexOf(0x1b, pos);
      if (escIdx < 0) {
        if (pos < bytes.length) this.onNonTspBytes(bytes.subarray(pos));
        break;
      }
      if (escIdx > pos) {
        this.onNonTspBytes(bytes.subarray(pos, escIdx));
      }

      const remaining = bytes.length - escIdx;
      if (remaining < APC_TSP.length) {
        let partialMatch = true;
        for (let i = 0; i < remaining; i += 1) {
          if (bytes[escIdx + i] !== APC_TSP[i]) {
            partialMatch = false;
            break;
          }
        }
        if (partialMatch) {
          this.held = bytes.slice(escIdx);
          break;
        }
        this.onNonTspBytes(bytes.subarray(escIdx, escIdx + 1));
        pos = escIdx + 1;
        continue;
      }

      let fullMatch = true;
      for (let i = 0; i < APC_TSP.length; i += 1) {
        if (bytes[escIdx + i] !== APC_TSP[i]) {
          fullMatch = false;
          break;
        }
      }
      if (fullMatch) {
        this.collecting = { parts: [], esc: false };
        pos = escIdx + APC_TSP.length;
      } else {
        this.onNonTspBytes(bytes.subarray(escIdx, escIdx + 1));
        pos = escIdx + 1;
      }
    }
  }
}

function cloneJson(value: Json): Json {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = cloneJson(v);
  }
  return out;
}

function materializeWireNode(wire: WireNode): TspNode {
  const props: Record<string, Json> = {};
  if (wire.p) {
    for (const [k, v] of Object.entries(wire.p)) {
      props[k] = cloneJson(v);
    }
  }
  const children: TspNode[] = wire.c ? wire.c.map(materializeWireNode) : [];
  return { id: wire.id, k: wire.k, p: props, c: children };
}

function registerSubtree(
  surface: MutableSurfaceState,
  node: TspNode,
  parentId: string,
): void {
  surface.nodes.set(node.id, node);
  surface.parentOf.set(node.id, parentId);
  for (const child of node.c) {
    registerSubtree(surface, child, node.id);
  }
}

function unregisterSubtree(surface: MutableSurfaceState, node: TspNode): void {
  surface.nodes.delete(node.id);
  surface.parentOf.delete(node.id);
  surface.settledIds.delete(node.id);
  if (surface.focusedId === node.id) surface.focusedId = null;
  for (const child of node.c) {
    unregisterSubtree(surface, child);
  }
}

function spansText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  let out = '';
  for (const part of value) {
    if (typeof part === 'string') {
      out += part;
    } else if (part && typeof part === 'object' && typeof (part as { t?: unknown }).t === 'string') {
      out += (part as { t: string }).t;
    }
  }
  return out;
}

function strVal(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pushNonEmpty(parts: string[], text: string): void {
  if (text.length > 0) parts.push(text);
}

function extractNodeOwnText(node: TspNode): string {
  const p = node.p;
  const parts: string[] = [];
  const slotText = (slot: string): string => {
    const val = p[slot];
    if (typeof val === 'string' && node.c.some(ch => ch.id === val)) return '';
    return spansText(val);
  };

  switch (node.k) {
    case 'text':
    case 'shimmer':
    case 'seg':
      pushNonEmpty(parts, Array.isArray(p['spans']) ? spansText(p['spans']) : strVal(p['text']));
      break;
    case 'md':
    case 'code':
    case 'ansi':
    case 'math':
    case 'editor':
    case 'input':
    case 'badge':
    case 'button':
      pushNonEmpty(parts, strVal(p['text']));
      break;
    case 'toast':
      pushNonEmpty(parts, strVal(p['text']));
      pushNonEmpty(parts, strVal(p['sub']));
      break;
    case 'empty':
      pushNonEmpty(parts, spansText(p['title']));
      pushNonEmpty(parts, spansText(p['text']));
      break;
    case 'rule':
      pushNonEmpty(parts, spansText(p['label']));
      pushNonEmpty(parts, strVal(p['time']));
      break;
    case 'card':
    case 'section':
    case 'overlay':
      pushNonEmpty(parts, slotText('head'));
      pushNonEmpty(parts, spansText(p['meta']));
      break;
    case 'tool': {
      pushNonEmpty(parts, spansText(p['title']));
      pushNonEmpty(parts, strVal(p['name']));
      pushNonEmpty(parts, spansText(p['target']));
      pushNonEmpty(parts, spansText(p['note']));
      pushNonEmpty(parts, strVal(p['approved']));
      if (Array.isArray(p['badges'])) {
        for (const b of p['badges']) {
          if (b && typeof b === 'object' && !Array.isArray(b)) {
            pushNonEmpty(parts, strVal((b as JsonObject)['text']));
          }
        }
      }
      if (Array.isArray(p['meta'])) {
        for (const m of p['meta']) pushNonEmpty(parts, spansText(m));
      }
      if (p['ask'] && typeof p['ask'] === 'object' && !Array.isArray(p['ask'])) {
        const ask = p['ask'] as JsonObject;
        pushNonEmpty(parts, strVal(ask['text']));
        pushNonEmpty(parts, strVal(ask['allow']));
        pushNonEmpty(parts, strVal(ask['deny']));
        pushNonEmpty(parts, strVal(ask['always']));
      }
      break;
    }
    case 'message':
      pushNonEmpty(parts, strVal(p['author']));
      pushNonEmpty(parts, strVal(p['time']));
      pushNonEmpty(parts, strVal(p['status']));
      break;
    case 'trace':
      pushNonEmpty(parts, spansText(p['title']));
      pushNonEmpty(parts, spansText(p['summary']));
      if (Array.isArray(p['lines'])) {
        for (const line of p['lines']) {
          if (line && typeof line === 'object' && !Array.isArray(line)) {
            const obj = line as JsonObject;
            pushNonEmpty(parts, spansText(obj['title']));
            pushNonEmpty(parts, spansText(obj['target']));
            pushNonEmpty(parts, spansText(obj['detail']));
          }
        }
      }
      break;
    case 'checklist':
      pushNonEmpty(parts, spansText(p['note']));
      if (Array.isArray(p['phases'])) {
        for (const ph of p['phases']) {
          if (ph && typeof ph === 'object' && !Array.isArray(ph)) {
            const phObj = ph as JsonObject;
            pushNonEmpty(parts, spansText(phObj['title']));
            if (Array.isArray(phObj['items'])) {
              for (const item of phObj['items']) {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                  const itObj = item as JsonObject;
                  pushNonEmpty(parts, spansText(itObj['text']));
                  pushNonEmpty(parts, spansText(itObj['note']));
                }
              }
            }
          }
        }
      }
      break;
    case 'suggestions':
      if (Array.isArray(p['items'])) {
        for (const item of p['items']) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const obj = item as JsonObject;
            pushNonEmpty(parts, strVal(obj['text']));
            pushNonEmpty(parts, strVal(obj['detail']));
          }
        }
      }
      break;
    case 'picker':
      pushNonEmpty(parts, spansText(p['title']));
      pushNonEmpty(parts, spansText(p['subtitle']));
      pushNonEmpty(parts, spansText(p['message']));
      pushNonEmpty(parts, spansText(p['empty']));
      pushNonEmpty(parts, strVal(p['query']));
      if (Array.isArray(p['tabs'])) {
        for (const tab of p['tabs']) {
          if (tab && typeof tab === 'object' && !Array.isArray(tab)) {
            pushNonEmpty(parts, spansText((tab as JsonObject)['label']));
          }
        }
      }
      if (Array.isArray(p['items'])) {
        for (const item of p['items']) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const obj = item as JsonObject;
            pushNonEmpty(parts, spansText(obj['label']));
            pushNonEmpty(parts, spansText(obj['detail']));
            if (Array.isArray(obj['badges'])) {
              for (const b of obj['badges']) {
                if (b && typeof b === 'object' && !Array.isArray(b)) {
                  pushNonEmpty(parts, strVal((b as JsonObject)['text']));
                }
              }
            }
          }
        }
      }
      break;
    case 'prefs':
      pushNonEmpty(parts, strVal(p['title']));
      pushNonEmpty(parts, strVal(p['lead']));
      pushNonEmpty(parts, strVal(p['query']));
      if (Array.isArray(p['pages'])) {
        for (const page of p['pages']) {
          if (page && typeof page === 'object' && !Array.isArray(page)) {
            pushNonEmpty(parts, strVal((page as JsonObject)['label']));
          }
        }
      }
      if (Array.isArray(p['sections'])) {
        for (const sec of p['sections']) {
          if (sec && typeof sec === 'object' && !Array.isArray(sec)) {
            const secObj = sec as JsonObject;
            pushNonEmpty(parts, strVal(secObj['title']));
            if (Array.isArray(secObj['rows'])) {
              for (const row of secObj['rows']) {
                if (row && typeof row === 'object' && !Array.isArray(row)) {
                  const rowObj = row as JsonObject;
                  pushNonEmpty(parts, spansText(rowObj['label']));
                  pushNonEmpty(parts, spansText(rowObj['hint']));
                  pushNonEmpty(parts, strVal(rowObj['warning']));
                }
              }
            }
          }
        }
      }
      break;
    case 'kv':
      if (Array.isArray(p['items'])) {
        for (const item of p['items']) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const obj = item as JsonObject;
            pushNonEmpty(parts, spansText(obj['k']));
            pushNonEmpty(parts, spansText(obj['v']));
          }
        }
      }
      break;
    case 'stats':
      if (Array.isArray(p['items'])) {
        for (const item of p['items']) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const obj = item as JsonObject;
            pushNonEmpty(parts, spansText(obj['label']));
            pushNonEmpty(parts, spansText(obj['value']));
            pushNonEmpty(parts, spansText(obj['sub']));
          }
        }
      }
      break;
    case 'table':
      if (Array.isArray(p['cols'])) {
        for (const col of p['cols']) {
          if (col && typeof col === 'object' && !Array.isArray(col)) {
            pushNonEmpty(parts, spansText((col as JsonObject)['head']));
          }
        }
      }
      if (Array.isArray(p['rows'])) {
        for (const row of p['rows']) {
          if (row && typeof row === 'object' && !Array.isArray(row)) {
            const cells = (row as JsonObject)['cells'];
            if (Array.isArray(cells)) {
              for (const cell of cells) {
                if (typeof cell === 'string' || Array.isArray(cell)) {
                  pushNonEmpty(parts, spansText(cell));
                } else if (cell && typeof cell === 'object') {
                  const cObj = cell as JsonObject;
                  pushNonEmpty(parts, spansText(cObj['text']));
                  pushNonEmpty(parts, spansText(cObj['label']));
                }
              }
            }
          }
        }
      }
      pushNonEmpty(parts, spansText(p['empty']));
      break;
    case 'diff':
      pushNonEmpty(parts, strVal(p['path']));
      pushNonEmpty(parts, strVal(p['text']));
      if (Array.isArray(p['hunks'])) {
        for (const hunk of p['hunks']) {
          if (hunk && typeof hunk === 'object' && !Array.isArray(hunk)) {
            const lines = (hunk as JsonObject)['lines'];
            if (Array.isArray(lines)) {
              for (const line of lines) pushNonEmpty(parts, strVal(line));
            }
          }
        }
      }
      break;
    case 'attachment':
      pushNonEmpty(parts, strVal(p['name']));
      pushNonEmpty(parts, strVal(p['meta']));
      pushNonEmpty(parts, strVal(p['error']));
      break;
    case 'item':
      pushNonEmpty(parts, spansText(p['label']));
      pushNonEmpty(parts, spansText(p['detail']));
      pushNonEmpty(parts, spansText(p['value']));
      break;
    case 'tabs':
      if (Array.isArray(p['items'])) {
        for (const item of p['items']) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            pushNonEmpty(parts, spansText((item as JsonObject)['label']));
          }
        }
      }
      break;
    case 'meter':
    case 'progress':
    case 'spinner':
      pushNonEmpty(parts, spansText(p['label']));
      pushNonEmpty(parts, spansText(p['total']));
      break;
    case 'rows':
      if (Array.isArray(p['lines'])) {
        for (const line of p['lines']) pushNonEmpty(parts, strVal(line));
      }
      break;
    case 'el':
      pushNonEmpty(parts, strVal(p['text']));
      break;
    default:
      break;
  }

  for (const slot of SLOT_KEYS) {
    if (slot !== 'head') {
      const text = slotText(slot);
      if (text) pushNonEmpty(parts, text);
    }
  }
  return parts.join('\n');
}

function extractTreeText(node: TspNode): string {
  const parts: string[] = [];
  const own = extractNodeOwnText(node);
  if (own.length > 0) parts.push(own);
  for (const child of node.c) {
    const childText = extractTreeText(child);
    if (childText.length > 0) parts.push(childText);
  }
  return parts.join('\n');
}

function collectByKind(node: TspNode, kind: string, out: TspNode[]): void {
  if (node.k === kind) out.push(node);
  for (const child of node.c) collectByKind(child, kind, out);
}

const F_TILDE_CODES: Readonly<Record<string, number>> = {
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24,
  f13: 25,
  f14: 26,
  f15: 28,
  f16: 29,
  f17: 31,
  f18: 32,
  f19: 33,
  f20: 34,
};

const ARROW_FINALS: Readonly<Record<string, string>> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
  home: 'H',
  end: 'F',
  begin: 'E',
};

const TILDE_SPECIALS: Readonly<Record<string, number>> = {
  insert: 2,
  delete: 3,
  page_up: 5,
  pgup: 5,
  page_down: 6,
  pgdn: 6,
};

function encodeKeyName(keyName: string): string {
  const parts = keyName.split('+');
  const rawBase = parts.pop() ?? '';
  let shift = false;
  let alt = false;
  let ctrl = false;
  let meta = false;

  for (const rawMod of parts) {
    const mod = rawMod.trim().toLowerCase();
    if (mod === 'shift') shift = true;
    else if (mod === 'alt') alt = true;
    else if (mod === 'ctrl' || mod === 'control') ctrl = true;
    else if (mod === 'meta' || mod === 'cmd' || mod === 'super') meta = true;
    else throw new Error(`Unknown key modifier "${rawMod}" in "${keyName}"`);
  }

  const bits = (shift ? 1 : 0) | (alt ? 2 : 0) | (ctrl ? 4 : 0) | (meta ? 8 : 0);
  const lower = rawBase.toLowerCase();

  if (lower === 'escape' || lower === 'esc') {
    return bits === 0 ? '\x1b[27u' : `\x1b[27;${1 + bits}u`;
  }
  if (lower === 'enter' || lower === 'return') {
    return bits === 0 ? '\r' : `\x1b[13;${1 + bits}u`;
  }
  if (lower === 'tab') {
    if (bits === 0) return '\t';
    if (bits === 1) return '\x1b[Z';
    return `\x1b[9;${1 + bits}u`;
  }
  if (lower === 'backspace') {
    if (bits === 0) return '\x7f';
    if (bits === 2) return '\x1b\x7f';
    return `\x1b[127;${1 + bits}u`;
  }
  if (lower === 'space') {
    return bits === 0 ? ' ' : `\x1b[32;${1 + bits}u`;
  }

  const arrowFinal = ARROW_FINALS[lower];
  if (arrowFinal) {
    return bits === 0 ? `\x1b[${arrowFinal}` : `\x1b[1;${1 + bits}${arrowFinal}`;
  }

  const tildeCode = TILDE_SPECIALS[lower] ?? F_TILDE_CODES[lower];
  if (tildeCode !== undefined) {
    return bits === 0 ? `\x1b[${tildeCode}~` : `\x1b[${tildeCode};${1 + bits}~`;
  }

  if (lower === 'f1' || lower === 'f2' || lower === 'f3' || lower === 'f4') {
    const fin = String.fromCharCode(0x50 + (Number(lower.slice(1)) - 1));
    return bits === 0 ? `\x1bO${fin}` : `\x1b[1;${1 + bits}${fin}`;
  }

  if (rawBase.length === 1) {
    const ch = shift && rawBase >= 'a' && rawBase <= 'z' && !ctrl && !alt && !meta
      ? rawBase.toUpperCase()
      : rawBase;
    const cp = lower.codePointAt(0)!;
    if (ctrl && !alt && !meta && !shift && lower >= 'a' && lower <= 'z') {
      if (lower === 'c') return '\x03';
      if (lower === 'h' || lower === 'i' || lower === 'm') {
        return `\x1b[${cp};${1 + bits}u`;
      }
      return String.fromCharCode(cp - 96);
    }
    if (bits === 0 || (bits === 1 && ch !== rawBase)) {
      return ch;
    }
    if (bits === 2) {
      return `\x1b${rawBase}`;
    }
    return `\x1b[${rawBase.codePointAt(0)!};${1 + bits}u`;
  }

  throw new Error(`Unsupported keyName: "${keyName}"`);
}

export class TspHarness {
  private readonly bridge: ChildProcessWithoutNullStreams;
  private readonly surfaces = new Map<string, MutableSurfaceState>();
  private readonly retiredSurfaces = new Map<string, MutableSurfaceState>();
  private readonly blobs = new Map<string, StoredBlob>();
  private readonly wireEvents: WireEventRecord[] = [];
  private readonly protocolErrors: string[] = [];
  private readonly rawDecoder = new TextDecoder('utf-8', { fatal: false });
  private readonly msgDecoder = new TextDecoder('utf-8', { fatal: false });
  private readonly waiters = new Set<() => void>();
  private readonly pendingRss = new Map<string, (kb: number) => void>();
  private readonly exitWaiters = new Set<(res: CloseResult) => void>();

  private activeSurfaceId: string | null = null;
  private rawOutput = '';
  private stdoutLineBuf = '';
  private stderrTail = '';
  private bridgePid: number | null = null;
  private exitResult: CloseResult | null = null;
  private helloCompleted = false;
  private requestCounter = 0;

  private cols: number;
  private rows: number;
  private cell: CellSize;
  private dark: boolean;
  private reduceMotion: boolean;
  private hour12: boolean;
  private readonly apcLimit: number;
  private readonly credits: number;
  private readonly features: readonly TerminalFeature[];
  private readonly kinds: readonly string[];
  private readonly autoAck: boolean;

  private constructor(
    bridge: ChildProcessWithoutNullStreams,
    opts: TspLaunchOptions,
  ) {
    this.bridge = bridge;
    this.cols = opts.cols ?? 120;
    this.rows = opts.rows ?? 40;
    this.cell = opts.cell ?? { w: 8, h: 16 };
    this.dark = opts.dark ?? true;
    this.reduceMotion = opts.reduceMotion ?? false;
    this.hour12 = opts.hour12 ?? false;
    this.apcLimit = opts.apc ?? DEFAULT_APC;
    this.credits = opts.credits ?? DEFAULT_CREDITS;
    this.features = opts.features ? [...opts.features] : [...TERMINAL_FEATURES];
    this.kinds = opts.kinds ? [...opts.kinds] : [...KINDS];
    this.autoAck = opts.autoAck ?? true;
  }

  static async launch(opts: TspLaunchOptions): Promise<TspHarness> {
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;
    const cwd = opts.cwd ?? opts.isolatedEnv?.workspace ?? process.cwd();
    const env = buildTspEnv(opts.isolatedEnv, opts.env);
    const cliEntry = resolve(REPO_ROOT, opts.cliEntry ?? 'src/cli.tsx');
    const cliArgs = [
      process.execPath,
      'run',
      cliEntry,
      ...(opts.agyPath ? ['--agy', opts.agyPath] : []),
      ...(opts.args ?? []),
    ];

    const bridge = spawn(
      'python3',
      [PTY_BRIDGE_PATH, '--cols', String(cols), '--rows', String(rows), '--cwd', cwd, '--', ...cliArgs],
      {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const harness = new TspHarness(bridge, opts);
    const parser = new TspStreamParser(
      msg => harness.handleTspMessage(msg),
      bytes => {
        harness.rawOutput += harness.rawDecoder.decode(bytes, { stream: true });
      },
      err => harness.protocolErrors.push(err),
    );

    const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 5_000;
    let resolveHandshake!: () => void;
    let rejectHandshake!: (err: Error) => void;
    const handshakePromise = new Promise<void>((res, rej) => {
      resolveHandshake = res;
      rejectHandshake = rej;
    });

    const onHandshakeReady = (): void => {
      if (harness.helloCompleted) resolveHandshake();
    };
    harness.waiters.add(onHandshakeReady);

    bridge.stdin.on('error', () => {});
    bridge.stderr.on('data', (chunk: Buffer) => {
      harness.stderrTail = (harness.stderrTail + chunk.toString('utf8')).slice(-4096);
    });

    bridge.stdout.on('data', (chunk: Buffer) => {
      harness.stdoutLineBuf += chunk.toString('utf8');
      let nl = harness.stdoutLineBuf.indexOf('\n');
      while (nl >= 0) {
        const line = harness.stdoutLineBuf.slice(0, nl).trim();
        harness.stdoutLineBuf = harness.stdoutLineBuf.slice(nl + 1);
        if (line.length > 0) {
          harness.handleBridgeLine(line, parser);
        }
        nl = harness.stdoutLineBuf.indexOf('\n');
      }
    });

    bridge.once('error', err => {
      if (!harness.helloCompleted) {
        rejectHandshake(new Error(`Failed to spawn pty_bridge.py: ${err.message}`));
      }
      harness.markExited(null, null);
    });

    bridge.once('close', (code, signal) => {
      if (!harness.exitResult) {
        harness.markExited(code, signal);
      }
      if (!harness.helloCompleted) {
        rejectHandshake(
          new Error(
            `Process exited before TSP hello handshake (code=${String(code)}, signal=${String(signal)}): ${harness.rawOutput.slice(-1024)} ${harness.stderrTail}`,
          ),
        );
      }
    });

    const timer = setTimeout(() => {
      if (!harness.helloCompleted) {
        void harness.close({ sendQuitKey: false, gracefulTimeoutMs: 250 });
        rejectHandshake(
          new Error(
            `Timed out waiting ${handshakeTimeoutMs}ms for TSP hello query. rawOutput=${harness.rawOutput.slice(-512)} stderr=${harness.stderrTail}`,
          ),
        );
      }
    }, handshakeTimeoutMs);

    try {
      await handshakePromise;
    } finally {
      clearTimeout(timer);
      harness.waiters.delete(onHandshakeReady);
    }

    return harness;
  }

  private handleBridgeLine(line: string, parser: TspStreamParser): void {
    let ev: BridgeEvent;
    try {
      ev = JSON.parse(line) as BridgeEvent;
    } catch {
      this.protocolErrors.push(`Invalid bridge JSONL line: ${line}`);
      return;
    }
    switch (ev.type) {
      case 'started':
        this.bridgePid = ev.pid;
        break;
      case 'data': {
        const bytes = Buffer.from(ev.data, 'base64');
        parser.feed(bytes);
        break;
      }
      case 'rss': {
        if (ev.id !== undefined) {
          const resolveRss = this.pendingRss.get(ev.id);
          if (resolveRss) {
            this.pendingRss.delete(ev.id);
            resolveRss(ev.kb ?? 0);
          }
        }
        break;
      }
      case 'exit':
        this.markExited(ev.code, ev.signal);
        break;
      case 'error':
        this.protocolErrors.push(`pty_bridge error: ${ev.message}`);
        break;
      case 'resized':
        break;
    }
  }

  private markExited(exitCode: number | null, signal: string | null): void {
    if (this.exitResult) return;
    this.exitResult = { exitCode, signal };
    for (const resolveRss of this.pendingRss.values()) {
      resolveRss(0);
    }
    this.pendingRss.clear();
    for (const resolveExit of this.exitWaiters) {
      resolveExit(this.exitResult);
    }
    this.exitWaiters.clear();
    this.notifyWaiters();
  }

  private notifyWaiters(): void {
    for (const fn of [...this.waiters]) {
      fn();
    }
  }

  private sendBridge(payload: Record<string, unknown>): void {
    if (this.bridge.stdin.destroyed || !this.bridge.stdin.writable) return;
    this.bridge.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private sendTspEvent(ev: Record<string, Json>): void {
    const seq = `\x1b_tsp;e;${JSON.stringify(ev)}\x1b\\`;
    this.wireEvents.push({ ts: Date.now(), dir: 'in', verb: 'e', body: ev });
    this.sendRawBytes(seq);
  }

  private handleTspMessage(msg: ParsedMessage): void {
    if (msg.verb === 'b') {
      const b64 = this.msgDecoder.decode(msg.body);
      const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
      const id = blobId(bytes);
      const mime = msg.params['mime'];
      this.blobs.set(id, { id, mime, bytes, byteLength: bytes.length });
      this.wireEvents.push({
        ts: Date.now(),
        dir: 'out',
        verb: 'b',
        id,
        mime,
        byteLength: bytes.length,
        params: msg.params,
      });
      this.notifyWaiters();
      return;
    }

    const text = this.msgDecoder.decode(msg.body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.protocolErrors.push(`Invalid JSON in TSP '${msg.verb}' body: ${String(err)}`);
      return;
    }
    if (!isJsonObject(parsed)) {
      this.protocolErrors.push(`TSP '${msg.verb}' body is not a JSON object`);
      return;
    }

    switch (msg.verb) {
      case 'q': {
        const query = parsed as unknown as Query;
        this.wireEvents.push({ ts: Date.now(), dir: 'out', verb: 'q', body: query, params: msg.params });
        if (query.q === 'hello') {
          const reply: HelloReply = {
            r: 'hello',
            v: PROTOCOL_VERSION,
            term: 'tsp-emulator',
            ver: '1.0.0',
            kinds: [...this.kinds],
            features: [...this.features],
            apc: this.apcLimit,
            credits: this.credits,
            cols: this.cols,
            cell: this.cell,
            dark: this.dark,
            reduceMotion: this.reduceMotion,
            hour12: this.hour12,
            raw: {},
          };
          const wireReply = {
            r: reply.r,
            v: reply.v,
            term: reply.term,
            ver: reply.ver,
            kinds: reply.kinds,
            features: reply.features,
            apc: reply.apc,
            credits: reply.credits,
            cols: reply.cols,
            cell: reply.cell,
            dark: reply.dark,
            reduceMotion: reply.reduceMotion,
            hour12: reply.hour12,
          };
          this.sendRawBytes(`\x1b_tsp;r;${JSON.stringify(wireReply)}\x1b\\`);
          this.wireEvents.push({ ts: Date.now(), dir: 'in', verb: 'r', body: reply });
          this.helloCompleted = true;
          this.notifyWaiters();
        } else if (query.q === 'blobs') {
          const have = Array.isArray(query.ids) ? query.ids.filter(id => this.blobs.has(id)) : [];
          const reply = { r: 'blobs' as const, have };
          this.sendRawBytes(`\x1b_tsp;r;${JSON.stringify(reply)}\x1b\\`);
          this.wireEvents.push({ ts: Date.now(), dir: 'in', verb: 'r', body: reply });
        }
        break;
      }
      case 'o': {
        const openMsg = parsed as unknown as OpenMessage;
        this.wireEvents.push({ ts: Date.now(), dir: 'out', verb: 'o', body: openMsg, params: msg.params });
        this.handleOpen(openMsg);
        this.notifyWaiters();
        break;
      }
      case 'f': {
        const frameMsg = parsed as unknown as FrameMessage;
        this.wireEvents.push({ ts: Date.now(), dir: 'out', verb: 'f', body: frameMsg, params: msg.params });
        this.handleFrame(frameMsg);
        this.notifyWaiters();
        break;
      }
      case 's': {
        const styleMsg = parsed as unknown as StylesheetMessage;
        this.wireEvents.push({ ts: Date.now(), dir: 'out', verb: 's', body: styleMsg, params: msg.params });
        const sf = styleMsg.sf ?? this.activeSurfaceId;
        if (sf) {
          const surface = this.surfaces.get(sf) ?? this.retiredSurfaces.get(sf);
          if (surface) {
            if (styleMsg.css === undefined) surface.stylesheets.delete(styleMsg.name);
            else surface.stylesheets.set(styleMsg.name, styleMsg.css);
          }
        }
        this.notifyWaiters();
        break;
      }
      case 'x': {
        const closeMsg = parsed as unknown as CloseMessage;
        this.wireEvents.push({ ts: Date.now(), dir: 'out', verb: 'x', body: closeMsg, params: msg.params });
        this.handleClose(closeMsg);
        this.notifyWaiters();
        break;
      }
      default:
        this.protocolErrors.push(`Unknown TSP verb '${msg.verb}'`);
        break;
    }
  }

  private handleOpen(msg: OpenMessage): void {
    const prev = this.retiredSurfaces.get(msg.id);
    if (msg.adopt && prev && prev.kept) {
      const nodes = new Map<string, TspNode>();
      const parentOf = new Map<string, string>();
      const settledIds = new Set<string>();
      const regions: TspRegions = { main: prev.regions.main, dock: null, layer: null };
      const restored: MutableSurfaceState = {
        id: msg.id,
        mode: msg.mode ?? prev.mode,
        title: msg.title ?? prev.title,
        role: msg.role ?? prev.role,
        listen: msg.listen ?? true,
        adopt: true,
        closable: msg.closable ?? false,
        font: msg.font ?? prev.font,
        closed: false,
        kept: false,
        suspended: false,
        focusedId: null,
        lastSeq: prev.lastSeq,
        ackedSeq: prev.ackedSeq,
        regions,
        nodes,
        parentOf,
        settledIds,
        stylesheets: new Map(prev.stylesheets),
        viewportEffects: [...prev.viewportEffects],
      };
      if (regions.main) {
        registerSubtree(restored, regions.main, msg.id);
        for (const id of prev.settledIds) {
          if (nodes.has(id)) settledIds.add(id);
        }
      }
      this.retiredSurfaces.delete(msg.id);
      this.surfaces.set(msg.id, restored);
      this.activeSurfaceId = msg.id;
      return;
    }

    const state: MutableSurfaceState = {
      id: msg.id,
      mode: msg.mode ?? 'screen',
      title: msg.title,
      role: msg.role,
      listen: msg.listen ?? true,
      adopt: Boolean(msg.adopt),
      closable: Boolean(msg.closable),
      font: msg.font ?? 'mono',
      closed: false,
      kept: false,
      suspended: false,
      focusedId: null,
      lastSeq: 0,
      ackedSeq: 0,
      regions: { main: null, dock: null, layer: null },
      nodes: new Map(),
      parentOf: new Map(),
      settledIds: new Set(),
      stylesheets: new Map(),
      viewportEffects: [],
    };
    this.surfaces.set(msg.id, state);
    this.activeSurfaceId = msg.id;
  }

  private handleClose(msg: CloseMessage): void {
    const surface = this.surfaces.get(msg.id);
    if (!surface) return;
    surface.closed = true;
    surface.kept = msg.keep !== false;
    if (surface.regions.dock) {
      unregisterSubtree(surface, surface.regions.dock);
      surface.regions.dock = null;
    }
    if (surface.regions.layer) {
      unregisterSubtree(surface, surface.regions.layer);
      surface.regions.layer = null;
    }
    if (!surface.kept && surface.regions.main) {
      unregisterSubtree(surface, surface.regions.main);
      surface.regions.main = null;
    }
    this.surfaces.delete(msg.id);
    this.retiredSurfaces.set(msg.id, surface);
    if (this.activeSurfaceId === msg.id) {
      const remaining = [...this.surfaces.keys()];
      this.activeSurfaceId = remaining.at(-1) ?? msg.id;
    }
  }

  private handleFrame(frame: FrameMessage): void {
    const surface = this.surfaces.get(frame.sf);
    if (!surface) {
      this.protocolErrors.push(`Frame s=${frame.s} targets unknown/closed surface '${frame.sf}'`);
      return;
    }

    const unacked = frame.s - surface.ackedSeq;
    if (surface.listen && unacked > this.credits) {
      this.protocolErrors.push(
        `Frame s=${frame.s} on '${frame.sf}' exceeded credit budget (${unacked} > ${this.credits})`,
      );
    }
    surface.lastSeq = frame.s;

    for (const op of frame.ops) {
      this.applyOp(surface, frame.s, op);
    }

    if (surface.listen && this.autoAck) {
      this.ackFrame(frame.sf, frame.s);
    }
  }

  private applyOp(surface: MutableSurfaceState, seq: number, op: Op): void {
    switch (op[0]) {
      case 'add': {
        const [, nodeId, parentId, beforeId, wire] = op;
        if (typeof wire !== 'object' || wire === null) break;
        const node = materializeWireNode(wire);
        if (!node.id && nodeId) {
          (node as { id: string }).id = nodeId;
        }
        if (parentId === surface.id && (node.id === 'main' || node.id === 'dock' || node.id === 'layer')) {
          const region = node.id as RegionName;
          const prevRegion = surface.regions[region];
          if (prevRegion) unregisterSubtree(surface, prevRegion);
          surface.regions[region] = node;
          registerSubtree(surface, node, surface.id);
          return;
        }
        const parent = surface.nodes.get(parentId);
        if (!parent) {
          this.protocolErrors.push(`add op: missing parent '${parentId}' for '${node.id}'`);
          return;
        }
        const existing = surface.nodes.get(node.id);
        if (existing) {
          this.detachNode(surface, node.id);
          unregisterSubtree(surface, existing);
        }
        this.insertChild(parent, node, beforeId);
        registerSubtree(surface, node, parentId);
        break;
      }
      case 'set': {
        const [, id, patch] = op;
        const node = surface.nodes.get(id);
        if (!node) {
          this.protocolErrors.push(`set op: missing node '${id}'`);
          return;
        }
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete node.p[k];
          else node.p[k] = cloneJson(v);
        }
        break;
      }
      case 'text': {
        const [, id, mode, chunk] = op;
        const node = surface.nodes.get(id);
        if (!node) {
          this.protocolErrors.push(`text op: missing node '${id}'`);
          return;
        }
        const cur = typeof node.p['text'] === 'string' ? node.p['text'] : '';
        node.p['text'] = mode === 'append' ? cur + chunk : chunk;
        break;
      }
      case 'splice': {
        const [, id, from, delCount, ins] = op;
        const node = surface.nodes.get(id);
        if (!node) {
          this.protocolErrors.push(`splice op: missing node '${id}'`);
          return;
        }
        const cur = typeof node.p['text'] === 'string' ? node.p['text'] : '';
        node.p['text'] = cur.slice(0, from) + ins + cur.slice(from + delCount);
        break;
      }
      case 'move': {
        const [, id, parentId, beforeId] = op;
        const node = surface.nodes.get(id);
        const nextParent = surface.nodes.get(parentId);
        if (!node || !nextParent) {
          this.protocolErrors.push(`move op: missing node '${id}' or parent '${parentId}'`);
          return;
        }
        this.detachNode(surface, id);
        this.insertChild(nextParent, node, beforeId);
        surface.parentOf.set(id, parentId);
        break;
      }
      case 'del': {
        const [, id] = op;
        const node = surface.nodes.get(id);
        if (!node) {
          // Safe no-op when `adopt: true` initially emits `['del', 'main']` with no prior `main`.
          return;
        }
        this.detachNode(surface, id);
        unregisterSubtree(surface, node);
        break;
      }
      case 'settle': {
        const [, id] = op;
        surface.settledIds.add(id);
        break;
      }
      case 'focus': {
        const [, id] = op;
        surface.focusedId = id;
        break;
      }
      case 'reveal': {
        const [, id, at] = op;
        surface.viewportEffects.push({ kind: 'reveal', sf: surface.id, s: seq, id, at });
        break;
      }
      case 'scroll': {
        const [, id, to] = op;
        surface.viewportEffects.push({ kind: 'scroll', sf: surface.id, s: seq, id, to });
        break;
      }
      case 'suspend': {
        surface.suspended = true;
        surface.viewportEffects.push({ kind: 'suspend', sf: surface.id, s: seq });
        break;
      }
      case 'resume': {
        surface.suspended = false;
        surface.viewportEffects.push({ kind: 'resume', sf: surface.id, s: seq });
        break;
      }
    }
  }

  private insertChild(parent: TspNode, child: TspNode, beforeId: string | null): void {
    if (beforeId !== null) {
      const idx = parent.c.findIndex(item => item.id === beforeId);
      if (idx >= 0) {
        parent.c.splice(idx, 0, child);
        return;
      }
    }
    parent.c.push(child);
  }

  private detachNode(surface: MutableSurfaceState, id: string): void {
    const parentId = surface.parentOf.get(id);
    if (parentId === surface.id && (id === 'main' || id === 'dock' || id === 'layer')) {
      surface.regions[id] = null;
      return;
    }
    if (!parentId) return;
    const parent = surface.nodes.get(parentId);
    if (!parent) return;
    const idx = parent.c.findIndex(item => item.id === id);
    if (idx >= 0) parent.c.splice(idx, 1);
  }

  private resolveSurface(sf?: string): MutableSurfaceState | undefined {
    if (sf !== undefined) {
      return this.surfaces.get(sf) ?? this.retiredSurfaces.get(sf);
    }
    if (this.activeSurfaceId) {
      const active = this.surfaces.get(this.activeSurfaceId);
      if (active) return active;
    }
    const open = [...this.surfaces.values()];
    if (open.length > 0) return open.at(-1);
    return this.activeSurfaceId ? this.retiredSurfaces.get(this.activeSurfaceId) : undefined;
  }

  private async waitUntil<T>(
    check: () => T | undefined,
    timeoutMs: number,
    describeTimeout: () => string,
    rejectOnExit = true,
  ): Promise<T> {
    const immediate = check();
    if (immediate !== undefined) return immediate;
    if (rejectOnExit && this.exitResult) {
      throw new Error(
        `Process already exited (code=${String(this.exitResult.exitCode)}, signal=${String(this.exitResult.signal)}) before condition met: ${describeTimeout()}`,
      );
    }

    return await new Promise<T>((resolvePromise, rejectPromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        this.waiters.delete(onUpdate);
        if (timer !== undefined) clearTimeout(timer);
      };
      const onUpdate = (): void => {
        try {
          const res = check();
          if (res !== undefined) {
            cleanup();
            resolvePromise(res);
            return;
          }
        } catch (err) {
          cleanup();
          rejectPromise(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (rejectOnExit && this.exitResult) {
          cleanup();
          rejectPromise(
            new Error(
              `Process exited prematurely (code=${String(this.exitResult.exitCode)}, signal=${String(this.exitResult.signal)}) while waiting: ${describeTimeout()}`,
            ),
          );
        }
      };

      timer = setTimeout(() => {
        cleanup();
        rejectPromise(new Error(`Timed out after ${timeoutMs}ms: ${describeTimeout()}`));
      }, timeoutMs);

      this.waiters.add(onUpdate);
    });
  }

  async waitForReady(opts?: WaitForReadyOptions | number): Promise<void> {
    const options: WaitForReadyOptions = typeof opts === 'number' ? { timeoutMs: opts } : (opts ?? {});
    const timeoutMs = options.timeoutMs ?? 8_000;
    const waitForAgent = options.waitForAgent ?? true;
    const allowDisconnected = options.allowDisconnected ?? false;

    await this.waitUntil<true>(
      () => {
        const surface = this.resolveSurface();
        if (!surface || surface.closed) return undefined;
        const draft = this.findById('dock.draft', surface.id) ?? this.findByKind('editor', 'dock', surface.id)[0];
        if (!draft) return undefined;
        if (!waitForAgent) return true;

        const stateSeg = this.getStatusSegments(surface.id).find(seg => seg.key === 'state');
        if (!stateSeg) return undefined;
        const text = stateSeg.text;
        if (
          text === 'Connecting to Antigravity' ||
          text === 'Reconnecting to Antigravity' ||
          text === 'Syncing history'
        ) {
          return undefined;
        }
        if (text === 'Connection failed' || text === 'Disconnected') {
          if (allowDisconnected) return true;
          const panelNode = this.findById('layer.panel', surface.id);
          if (panelNode) {
            const panelText = this.extractText(panelNode, surface.id);
            if (panelText.includes('Account') || panelText.includes('Sign in')) return true;
          }
          const mainText = this.extractText('main', surface.id);
          throw new Error(`Agent entered '${text}' state during waitForReady. Main region: ${mainText.slice(-500)}`);
        }
        return true;
      },
      timeoutMs,
      () => {
        const segs = this.getStatusSegments();
        return `surface ready (status=${JSON.stringify(segs.find(s => s.key === 'state')?.text ?? 'none')})`;
      },
    );
  }

  async waitForNode(
    pred: (node: TspNode) => boolean,
    timeoutMs = 5_000,
    sf?: string,
  ): Promise<TspNode> {
    return await this.waitUntil<TspNode>(
      () => {
        const surface = this.resolveSurface(sf);
        if (!surface) return undefined;
        for (const node of surface.nodes.values()) {
          if (pred(node)) return node;
        }
        return undefined;
      },
      timeoutMs,
      () => `matching TSP node on surface '${sf ?? this.activeSurfaceId ?? 'none'}'`,
    );
  }

  async waitForText(
    substr: string,
    region?: RegionName,
    timeoutMs = 5_000,
    sf?: string,
  ): Promise<string> {
    return await this.waitUntil<string>(
      () => {
        const text = this.extractText(region, sf);
        return text.includes(substr) ? text : undefined;
      },
      timeoutMs,
      () => `text containing ${JSON.stringify(substr)} in region '${region ?? 'all'}' (current=${JSON.stringify(this.extractText(region, sf).slice(-300))})`,
    );
  }

  async waitForSettled(id: string, timeoutMs = 5_000, sf?: string): Promise<void> {
    await this.waitUntil<true>(
      () => {
        const surface = this.resolveSurface(sf);
        return surface?.settledIds.has(id) ? true : undefined;
      },
      timeoutMs,
      () => `node '${id}' to be settled`,
    );
  }

  async waitForExit(timeoutMs = 5_000): Promise<CloseResult> {
    if (this.exitResult) return this.exitResult;
    return await new Promise<CloseResult>((resolvePromise, rejectPromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onExit = (res: CloseResult): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolvePromise(res);
      };
      timer = setTimeout(() => {
        this.exitWaiters.delete(onExit);
        rejectPromise(new Error(`Timed out after ${timeoutMs}ms waiting for process exit`));
      }, timeoutMs);
      this.exitWaiters.add(onExit);
    });
  }

  getTree(sf?: string): SurfaceSnapshot {
    const surface = this.resolveSurface(sf);
    if (!surface) {
      throw new Error(`No surface available for '${sf ?? 'active'}'`);
    }
    return {
      id: surface.id,
      mode: surface.mode,
      title: surface.title,
      role: surface.role,
      listen: surface.listen,
      adopt: surface.adopt,
      closable: surface.closable,
      font: surface.font,
      closed: surface.closed,
      kept: surface.kept,
      suspended: surface.suspended,
      focusedId: surface.focusedId,
      lastSeq: surface.lastSeq,
      ackedSeq: surface.ackedSeq,
      regions: { ...surface.regions },
      nodes: surface.nodes,
      settledIds: surface.settledIds,
      stylesheets: surface.stylesheets,
      viewportEffects: surface.viewportEffects,
    };
  }

  getRegions(sf?: string): TspRegions {
    const surface = this.resolveSurface(sf);
    if (!surface) return { main: null, dock: null, layer: null };
    return { ...surface.regions };
  }

  findById(id: string, sf?: string): TspNode | undefined {
    return this.resolveSurface(sf)?.nodes.get(id);
  }

  findByKind(kind: Kind | string, region?: RegionName, sf?: string): TspNode[] {
    const surface = this.resolveSurface(sf);
    if (!surface) return [];
    const out: TspNode[] = [];
    const roots = region
      ? [surface.regions[region]]
      : [surface.regions.main, surface.regions.dock, surface.regions.layer];
    for (const root of roots) {
      if (root) collectByKind(root, kind, out);
    }
    return out;
  }

  extractText(target?: TspNode | RegionName | string, sf?: string): string {
    const surface = this.resolveSurface(sf);
    if (!surface) return '';
    if (target === undefined) {
      const parts: string[] = [];
      for (const region of ['main', 'dock', 'layer'] as const) {
        const root = surface.regions[region];
        if (root) {
          const text = extractTreeText(root);
          if (text.length > 0) parts.push(text);
        }
      }
      return parts.join('\n');
    }
    if (typeof target === 'string') {
      if (target === 'main' || target === 'dock' || target === 'layer') {
        const root = surface.regions[target];
        return root ? extractTreeText(root) : '';
      }
      const node = surface.nodes.get(target);
      return node ? extractTreeText(node) : '';
    }
    return extractTreeText(target);
  }

  getStatusSegments(sf?: string): StatusSegmentInfo[] {
    const status = this.findById('dock.bar', sf) ?? this.findByKind('status', 'dock', sf)[0];
    if (!status) return [];
    const prefix = `${status.id}.`;
    const segments: StatusSegmentInfo[] = [];
    for (const child of status.c) {
      if (child.k !== 'seg') continue;
      const key = child.id.startsWith(prefix) ? child.id.slice(prefix.length) : child.id;
      const text = this.extractText(child, sf);
      segments.push({
        id: child.id,
        key,
        text,
        icon: typeof child.p['icon'] === 'string' ? child.p['icon'] : undefined,
        tone: typeof child.p['tone'] === 'string' ? child.p['tone'] : undefined,
        side: typeof child.p['side'] === 'string' ? child.p['side'] : undefined,
        priority: typeof child.p['priority'] === 'number' ? child.p['priority'] : undefined,
        title: typeof child.p['title'] === 'string' ? child.p['title'] : undefined,
      });
    }
    return segments;
  }

  getSettledIds(sf?: string): string[] {
    const surface = this.resolveSurface(sf);
    return surface ? [...surface.settledIds] : [];
  }

  getWireEvents(): readonly WireEventRecord[] {
    return this.wireEvents;
  }

  getBlobs(): ReadonlyMap<string, StoredBlob> {
    return this.blobs;
  }

  getProtocolErrors(): readonly string[] {
    return this.protocolErrors;
  }

  getRawOutput(): string {
    return this.rawOutput;
  }

  assertWireInvariants(opts?: WireInvariantOptions): void {
    if (this.protocolErrors.length > 0) {
      throw new Error(`Protocol errors recorded:\n${this.protocolErrors.join('\n')}`);
    }
    const allowEmojiSet = new Set(opts?.allowEmojiInNodeIds ?? []);
    const allowEl = opts?.allowEl ?? false;
    const violations: string[] = [];

    const checkSpanTokens = (nodeId: string, path: string, tokenStr: string): void => {
      const tokens = tokenStr.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        violations.push(`${nodeId}.${path}: empty SpanToken string`);
        return;
      }
      for (const tok of tokens) {
        if (!VALID_SPAN_TOKENS.has(tok)) {
          violations.push(`${nodeId}.${path}: invalid SpanToken '${tok}'`);
        }
      }
    };

    const inspectValue = (node: TspNode, propPath: string, val: Json, skipEmoji: boolean): void => {
      if (typeof val === 'string') {
        if (!skipEmoji && EMOJI_RE.test(val)) {
          violations.push(`${node.id}.${propPath}: contains literal emoji in ${JSON.stringify(val)}`);
        }
        if (EM_DASH_RE.test(val)) {
          violations.push(`${node.id}.${propPath}: contains em-dash (\\u2014) in ${JSON.stringify(val)}`);
        }
        return;
      }
      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i += 1) {
          inspectValue(node, `${propPath}[${i}]`, val[i]!, skipEmoji);
        }
        return;
      }
      if (val && typeof val === 'object') {
        const obj = val as JsonObject;
        if (typeof obj['t'] === 'string' && typeof obj['s'] === 'string') {
          checkSpanTokens(node.id, `${propPath}.s`, obj['s']);
        }
        if (typeof obj['tone'] === 'string' && !VALID_TONES.has(obj['tone'])) {
          violations.push(`${node.id}.${propPath}.tone: invalid Tone '${obj['tone']}'`);
        }
        if (typeof obj['dot'] === 'string' && !VALID_TONES.has(obj['dot'])) {
          violations.push(`${node.id}.${propPath}.dot: invalid Tone '${obj['dot']}'`);
        }
        for (const [k, v] of Object.entries(obj)) {
          inspectValue(node, `${propPath}.${k}`, v, skipEmoji);
        }
      }
    };

    const walk = (node: TspNode): void => {
      if (!VALID_KINDS.has(node.k)) {
        violations.push(`${node.id}: unknown kind '${node.k}'`);
      }
      if (!allowEl && node.k === 'el') {
        violations.push(`${node.id}: forbidden 'el' node`);
      }
      if (typeof node.p['tone'] === 'string' && !VALID_TONES.has(node.p['tone'])) {
        violations.push(`${node.id}.tone: invalid Tone '${node.p['tone']}'`);
      }
      if (typeof node.p['dot'] === 'string' && !VALID_TONES.has(node.p['dot'])) {
        violations.push(`${node.id}.dot: invalid Tone '${node.p['dot']}'`);
      }
      if (node.k === 'shimmer' && node.p['palette'] && typeof node.p['palette'] === 'object' && !Array.isArray(node.p['palette'])) {
        const pal = node.p['palette'] as JsonObject;
        for (const slot of ['low', 'mid', 'high'] as const) {
          if (typeof pal[slot] === 'string') {
            checkSpanTokens(node.id, `palette.${slot}`, pal[slot]);
          }
        }
      }
      if (Array.isArray(node.p['decor'])) {
        for (let i = 0; i < node.p['decor'].length; i += 1) {
          const item = node.p['decor'][i];
          if (item && typeof item === 'object' && !Array.isArray(item) && typeof (item as JsonObject)['s'] === 'string') {
            checkSpanTokens(node.id, `decor[${i}].s`, (item as JsonObject)['s'] as string);
          }
        }
      }

      const skipEmoji = allowEmojiSet.has(node.id);
      for (const [k, v] of Object.entries(node.p)) {
        inspectValue(node, k, v, skipEmoji);
      }
      for (const child of node.c) walk(child);
    };

    const surface = this.resolveSurface();
    if (surface) {
      for (const region of ['main', 'dock', 'layer'] as const) {
        const root = surface.regions[region];
        if (root) walk(root);
      }
    }

    if (violations.length > 0) {
      throw new Error(`Wire invariant violations:\n${violations.join('\n')}`);
    }
  }

  sendRawBytes(bytes: Uint8Array | string): void {
    const raw = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
    this.sendBridge({ op: 'write', data: Buffer.from(raw).toString('base64') });
  }

  sendText(text: string): void {
    this.sendRawBytes(text);
  }

  sendKey(keyName: string): void {
    this.sendRawBytes(encodeKeyName(keyName));
  }

  sendKeys(keys: string | readonly string[]): void {
    if (typeof keys === 'string') {
      this.sendKey(keys);
      return;
    }
    for (const k of keys) {
      this.sendKey(k);
    }
  }

  sendPaste(text: string): void {
    this.sendRawBytes(`\x1b[200~${text}\x1b[201~`);
  }

  sendAction(
    id: string,
    act: string,
    extra?: {
      readonly sf?: string;
      readonly item?: string;
      readonly value?: Json;
      readonly checked?: boolean;
      readonly mods?: readonly Mod[];
      readonly values?: FormValues;
    },
  ): void {
    const sf = extra?.sf ?? this.resolveSurface()?.id ?? 's1';
    const ev: Record<string, Json> = { ev: 'action', sf, id, act };
    if (extra?.item !== undefined) ev['item'] = extra.item;
    if (extra?.value !== undefined) ev['value'] = extra.value;
    if (extra?.checked !== undefined) ev['checked'] = extra.checked;
    if (extra?.mods !== undefined) ev['mods'] = extra.mods;
    if (extra?.values !== undefined) ev['values'] = extra.values as Json;
    this.sendTspEvent(ev);
  }

  sendToggle(
    id: string,
    patch: { readonly collapsed?: boolean; readonly open?: boolean; readonly item?: string; readonly key?: string; readonly sf?: string },
  ): void {
    const sf = patch.sf ?? this.resolveSurface()?.id ?? 's1';
    const ev: Record<string, Json> = { ev: 'toggle', sf, id };
    if (patch.collapsed !== undefined) ev['collapsed'] = patch.collapsed;
    if (patch.open !== undefined) ev['open'] = patch.open;
    if (patch.item !== undefined) ev['item'] = patch.item;
    if (patch.key !== undefined) ev['key'] = patch.key;
    this.sendTspEvent(ev);
  }

  sendSelect(id: string, item: string, extra?: { readonly values?: FormValues; readonly sf?: string }): void {
    const sf = extra?.sf ?? this.resolveSurface()?.id ?? 's1';
    const ev: Record<string, Json> = { ev: 'select', sf, id, item };
    if (extra?.values !== undefined) ev['values'] = extra.values as Json;
    this.sendTspEvent(ev);
  }

  sendActivate(id: string, item: string, extra?: { readonly values?: FormValues; readonly sf?: string }): void {
    const sf = extra?.sf ?? this.resolveSurface()?.id ?? 's1';
    const ev: Record<string, Json> = { ev: 'activate', sf, id, item };
    if (extra?.values !== undefined) ev['values'] = extra.values as Json;
    this.sendTspEvent(ev);
  }

  sendChange(
    id: string,
    patch: {
      readonly sf?: string;
      readonly value?: Json;
      readonly checked?: boolean;
      readonly name?: string;
      readonly item?: string;
      readonly on?: boolean;
      readonly values?: FormValues;
    },
  ): void {
    const sf = patch.sf ?? this.resolveSurface()?.id ?? 's1';
    const ev: Record<string, Json> = { ev: 'change', sf, id };
    if (patch.value !== undefined) ev['value'] = patch.value;
    if (patch.checked !== undefined) ev['checked'] = patch.checked;
    if (patch.name !== undefined) ev['name'] = patch.name;
    if (patch.item !== undefined) ev['item'] = patch.item;
    if (patch.on !== undefined) ev['on'] = patch.on;
    if (patch.values !== undefined) ev['values'] = patch.values as Json;
    this.sendTspEvent(ev);
  }

  sendEdit(id: string, from: number, to: number, text: string, cursor: number, len?: number, sf?: string): void {
    const resolvedSf = sf ?? this.resolveSurface()?.id ?? 's1';
    const node = this.findById(id, resolvedSf);
    const currentLen = len ?? (typeof node?.p['text'] === 'string' ? node.p['text'].length : 0);
    this.sendTspEvent({
      ev: 'edit',
      sf: resolvedSf,
      id,
      from,
      to,
      text,
      cursor,
      len: currentLen,
    });
  }

  sendUndo(id: string, sf?: string): void {
    const resolvedSf = sf ?? this.resolveSurface()?.id ?? 's1';
    this.sendTspEvent({ ev: 'undo', sf: resolvedSf, id });
  }

  sendFocus(id: string, sf?: string): void {
    const resolvedSf = sf ?? this.resolveSurface()?.id ?? 's1';
    this.sendTspEvent({ ev: 'focus', sf: resolvedSf, id });
  }

  resize(cols: number, rows: number, cell?: CellSize, sf?: string): void {
    this.cols = Math.max(1, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
    if (cell) this.cell = cell;
    this.sendBridge({ op: 'resize', cols: this.cols, rows: this.rows });
    const ev: Record<string, Json> = { ev: 'resize', cols: this.cols };
    if (sf !== undefined) ev['sf'] = sf;
    if (cell) ev['cell'] = { w: cell.w, h: cell.h };
    this.sendTspEvent(ev);
  }

  setTheme(dark: boolean): void {
    this.dark = dark;
    this.sendTspEvent({ ev: 'theme', dark });
  }

  setMotion(reduce: boolean): void {
    this.reduceMotion = reduce;
    this.sendTspEvent({ ev: 'motion', reduce });
  }

  setVisible(visible: boolean, sf?: string): void {
    const ev: Record<string, Json> = { ev: 'visible', visible };
    if (sf !== undefined) ev['sf'] = sf;
    this.sendTspEvent(ev);
  }

  ackFrame(sf: string, s: number): void {
    const surface = this.surfaces.get(sf);
    if (surface && s > surface.ackedSeq) {
      surface.ackedSeq = s;
    }
    this.sendTspEvent({ ev: 'ack', sf, s });
  }

  async measureRssKb(): Promise<number> {
    if (this.exitResult || this.bridgePid === null) return 0;
    const id = `rss-${++this.requestCounter}`;
    return await new Promise<number>(resolvePromise => {
      const timer = setTimeout(() => {
        this.pendingRss.delete(id);
        resolvePromise(0);
      }, 2_000);
      this.pendingRss.set(id, kb => {
        clearTimeout(timer);
        resolvePromise(kb);
      });
      this.sendBridge({ op: 'rss', id });
    });
  }

  async close(opts?: { readonly sendQuitKey?: boolean; readonly gracefulTimeoutMs?: number }): Promise<CloseResult> {
    if (this.exitResult) return this.exitResult;
    const sendQuitKey = opts?.sendQuitKey ?? true;
    const gracefulTimeoutMs = opts?.gracefulTimeoutMs ?? 2_000;

    if (sendQuitKey && this.helloCompleted) {
      this.sendKey('ctrl+q');
      try {
        return await this.waitForExit(gracefulTimeoutMs);
      } catch {
        // Fall through to bridge PGID kill.
      }
    }

    this.sendBridge({ op: 'kill', graceMs: 400 });
    try {
      return await this.waitForExit(1_500);
    } catch {
      try {
        this.bridge.kill('SIGKILL');
      } catch {
        // Ignore if bridge already exited.
      }
      return this.exitResult ?? { exitCode: null, signal: 'SIGKILL' };
    }
  }
}
