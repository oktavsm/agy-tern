import type { CompactionStatus, ContentBlock, PlanEntry, SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk';

export interface InlineImage {
  data: string;
  mimeType: string;
}

export interface ChatMessage {
  type: 'message';
  id: string;
  role: 'user' | 'agent';
  messageId?: string;
  text: string;
  time?: string;
  images?: InlineImage[];
}

export interface ThoughtEntry {
  type: 'thought';
  id: string;
  text: string;
  startedAt: number;
  endedAt?: number;
}

export interface ToolStep {
  type: 'tool';
  id: string;
  call: ToolCallUpdate;
  approved?: 'once' | 'denied';
  startedAt?: number;
  endedAt?: number;
}

export interface AgentPlan {
  type: 'plan';
  id: string;
  entries: PlanEntry[];
}

export interface NoticeEntry {
  type: 'notice';
  id: string;
  text: string;
  error: boolean;
  retryable?: boolean;
}

export interface CompactionEntry {
  type: 'compaction';
  id: string;
  compactionId: string;
  status: CompactionStatus;
  text: string;
  error?: string;
}

export type TranscriptEntry = ChatMessage | ThoughtEntry | ToolStep | AgentPlan | NoticeEntry | CompactionEntry;

export function contentText(content: ContentBlock): string {
  switch (content.type) {
    case 'text': return content.text;
    case 'resource_link': return `${content.title ?? content.name}\n${content.uri}`;
    case 'resource': return 'text' in content.resource
      ? `${content.resource.uri}\n${content.resource.text}`
      : `${content.resource.uri} (binary resource)`;
    case 'image': return `[Image: ${content.mimeType}]`;
    case 'audio': return `[Audio: ${content.mimeType}]`;
  }
}

export class Conversation {
  readonly entries: TranscriptEntry[] = [];
  private readonly tools = new Map<string, ToolStep>();
  private readonly messages = new Map<string, ChatMessage>();
  private readonly compactions = new Map<string, CompactionEntry>();
  private plan?: AgentPlan;
  private activeThought?: ThoughtEntry;
  private sequence = 0;
  private _revision = 0;
  private readonly revisions = new WeakMap<TranscriptEntry, number>();

  get revision(): number {
    return this._revision;
  }

  revisionOf(entry: TranscriptEntry): number {
    return this.revisions.get(entry) ?? 0;
  }

  private touch(entry?: TranscriptEntry): void {
    this._revision++;
    if (entry) this.revisions.set(entry, this._revision);
  }

  private closeThought(now = Date.now()): void {
    if (this.activeThought && this.activeThought.endedAt === undefined) {
      this.activeThought.endedAt = now;
      this.touch(this.activeThought);
    }
    this.activeThought = undefined;
  }

  get currentPlan(): AgentPlan | undefined {
    return this.plan;
  }

  finishTurn(now = Date.now(), aborted = false): void {
    this.closeThought(now);
    for (const entry of this.entries) {
      if (entry.type !== 'tool') continue;
      if (entry.call.status === 'in_progress' || entry.call.status === 'pending' || entry.call.status == null) {
        entry.call.status = aborted ? 'failed' : 'completed';
        if (entry.startedAt !== undefined && entry.endedAt === undefined) entry.endedAt = now;
        this.touch(entry);
      }
    }
  }

  /** Replace active transcript entries from a local snapshot cleanly while advancing sequence/tool indexes. */
  restoreEntries(entries: readonly TranscriptEntry[]): void {
    this.entries.length = 0;
    this.tools.clear();
    this.messages.clear();
    this.compactions.clear();
    this.plan = undefined;
    this.activeThought = undefined;
    let maxSeq = this.sequence;
    for (const entry of entries) {
      this.entries.push(entry);
      this.touch(entry);
      const idMatch = /^entry-(\d+)$/.exec(entry.id);
      if (idMatch) maxSeq = Math.max(maxSeq, Number(idMatch[1]));
      if (entry.type === 'tool') this.tools.set(entry.call.toolCallId, entry);
      if (entry.type === 'plan') this.plan = entry;
      if (entry.type === 'compaction') this.compactions.set(entry.compactionId, entry);
    }
    this.sequence = maxSeq;
  }

  startPrompt(text: string, time?: string): void {
    this.closeThought();
    this.messages.clear();
    this.plan = undefined;
    const entry: ChatMessage = { type: 'message', id: `entry-${++this.sequence}`, role: 'user', text, ...(time ? { time } : {}) };
    this.entries.push(entry);
    this.touch(entry);
  }

  notice(text: string, error = false, retryable = false): NoticeEntry {
    this.closeThought();
    const entry: NoticeEntry = { type: 'notice', id: `entry-${++this.sequence}`, text, error, ...(retryable ? { retryable } : {}) };
    this.entries.push(entry);
    this.touch(entry);
    return entry;
  }

  removeNotice(id: string): boolean {
    const idx = this.entries.findIndex(entry => entry.type === 'notice' && entry.id === id);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    this.touch();
    return true;
  }

  getTool(toolCallId: string): ToolStep | undefined {
    return this.tools.get(toolCallId);
  }

  tool(update: ToolCallUpdate, now = Date.now()): ToolStep {
    let step = this.tools.get(update.toolCallId);
    if (!step) {
      const initialActive = update.status === 'pending' || update.status === 'in_progress' || update.status == null;
      step = {
        type: 'tool',
        id: `entry-${++this.sequence}`,
        call: { toolCallId: update.toolCallId },
        ...(initialActive ? { startedAt: now } : {}),
      };
      this.tools.set(update.toolCallId, step);
      this.entries.push(step);
    }
    // ACP tool content is a replacement snapshot, not another output chunk.
    for (const field of ['title', 'kind', 'name', 'status', 'content', 'locations'] as const) {
      if (update[field] != null) Object.assign(step.call, { [field]: update[field] });
    }
    if ('rawInput' in update) step.call.rawInput = update.rawInput;
    if ('rawOutput' in update) step.call.rawOutput = update.rawOutput;
    if (step.startedAt !== undefined && step.endedAt === undefined &&
      (step.call.status === 'completed' || step.call.status === 'failed')) {
      step.endedAt = now;
    }
    this.touch(step);
    return step;
  }

  update(update: SessionUpdate, now = Date.now(), time?: string): void {
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk': {
        const text = contentText(update.content);
        if (!text) break;
        const tail = this.entries.at(-1);
        if (!this.activeThought || tail !== this.activeThought) {
          this.closeThought(now);
          this.activeThought = {
            type: 'thought',
            id: `entry-${++this.sequence}`,
            text: '',
            startedAt: now,
          };
          this.entries.push(this.activeThought);
        }
        this.activeThought.text += text;
        this.touch(this.activeThought);
        break;
      }
      case 'agent_message_chunk':
      case 'user_message_chunk': {
        this.closeThought(now);
        const role = update.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'user';
        const text = contentText(update.content);
        const tail = this.entries.at(-1);
        const key = update.messageId ? `${role}:${update.messageId}` : undefined;
        let message = key ? this.messages.get(key) :
          tail?.type === 'message' && tail.role === role && !tail.messageId ? tail : undefined;
        if (!message) {
          message = { type: 'message', id: `entry-${++this.sequence}`, role, text: '',
            messageId: update.messageId ?? undefined, ...(time ? { time } : {}) };
          if (key) this.messages.set(key, message);
          this.entries.push(message);
        }
        if (update.content.type === 'image') {
          message.images = [...(message.images ?? []), { data: update.content.data, mimeType: update.content.mimeType }];
        } else {
          message.text += text;
        }
        this.touch(message);
        break;
      }
      case 'tool_call':
      case 'tool_call_update':
        this.closeThought(now);
        this.tool(update, now);
        break;
      case 'plan':
        this.closeThought(now);
        if (!this.plan) {
          this.plan = { type: 'plan', id: `entry-${++this.sequence}`, entries: [] };
          this.entries.push(this.plan);
        }
        this.plan.entries = update.entries;
        this.touch(this.plan);
        break;
      case 'notice':
        this.notice(update.description ? `${update.title}: ${update.description}` : update.title, update.severity === 'error');
        break;
      case 'compaction_update': {
        this.closeThought(now);
        let entry = this.compactions.get(update.compactionId);
        if (!entry) {
          entry = {
            type: 'compaction',
            id: `entry-${++this.sequence}`,
            compactionId: update.compactionId,
            status: update.status,
            text: '',
          };
          this.compactions.set(update.compactionId, entry);
          this.entries.push(entry);
        }
        entry.status = update.status;
        if (update.summary) {
          entry.text = update.summary.map(contentText).filter(Boolean).join('\n');
        }
        if (update.error !== undefined) entry.error = update.error ?? undefined;
        this.touch(entry);
        break;
      }
      case 'compaction_summary_chunk': {
        this.closeThought(now);
        let entry = this.compactions.get(update.compactionId);
        if (!entry) {
          entry = {
            type: 'compaction',
            id: `entry-${++this.sequence}`,
            compactionId: update.compactionId,
            status: 'in_progress',
            text: '',
          };
          this.compactions.set(update.compactionId, entry);
          this.entries.push(entry);
        }
        const chunk = contentText(update.content);
        if (chunk) entry.text += chunk;
        this.touch(entry);
        break;
      }
    }
  }
}
