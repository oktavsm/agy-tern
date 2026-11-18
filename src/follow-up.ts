import type {
  CreateElicitationRequest,
  ElicitationContentValue,
  ElicitationPropertySchema,
  ElicitationSchema,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';

export interface QuestionOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export type QuestionField =
  | {
    readonly kind: 'single-select';
    readonly name: string;
    readonly label: string;
    readonly description?: string;
    readonly required: boolean;
    readonly options: readonly QuestionOption[];
    readonly defaultValue?: string;
    readonly allowCustom?: boolean;
  }
  | {
    readonly kind: 'multi-select';
    readonly name: string;
    readonly label: string;
    readonly description?: string;
    readonly required: boolean;
    readonly options: readonly QuestionOption[];
    readonly minItems?: number;
    readonly maxItems?: number;
    readonly defaultValue?: readonly string[];
  }
  | {
    readonly kind: 'boolean';
    readonly name: string;
    readonly label: string;
    readonly description?: string;
    readonly required: boolean;
    readonly defaultValue?: boolean;
  }
  | {
    readonly kind: 'text' | 'number' | 'integer';
    readonly name: string;
    readonly label: string;
    readonly description?: string;
    readonly required: boolean;
    readonly defaultValue?: string;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly format?: string;
  };

export type ParsedElicitation =
  | {
    readonly mode: 'form';
    readonly title: string;
    readonly message: string;
    readonly fields: readonly QuestionField[];
  }
  | {
    readonly mode: 'url';
    readonly title: string;
    readonly message: string;
    readonly elicitationId: string;
    readonly url: string;
  }
  | {
    readonly mode: 'unsupported';
    readonly title: string;
    readonly message: string;
  };

export type QuestionAnswerValue = string | boolean | string[];

export interface FollowUpSessionState {
  readonly title: string;
  readonly message: string;
  readonly fields: readonly QuestionField[];
  activeFieldIdx: number;
  answers: Record<string, QuestionAnswerValue>;
  customDrafts: Record<string, string>;
  freeNote: string;
  draftCursors?: Record<string, { cursor: number; anchor?: number }>;
  optionCursors?: Record<string, number>;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseSingleSelectOptions(prop: Record<string, unknown>): QuestionOption[] | undefined {
  if (Array.isArray(prop.oneOf)) {
    const out: QuestionOption[] = [];
    for (const item of prop.oneOf) {
      const rec = asRecord(item);
      if (!rec || typeof rec.const !== 'string') continue;
      out.push({
        value: rec.const,
        label: typeof rec.title === 'string' && rec.title.trim() ? rec.title : rec.const,
        ...(typeof rec.description === 'string' && rec.description.trim() ? { description: rec.description } : {}),
      });
    }
    return out.length ? out : undefined;
  }
  if (Array.isArray(prop.enum)) {
    const out = prop.enum
      .filter((item): item is string => typeof item === 'string')
      .map(value => ({ value, label: value }));
    return out.length ? out : undefined;
  }
  return undefined;
}

function parseMultiSelectOptions(items: unknown): QuestionOption[] {
  const rec = asRecord(items);
  if (!rec) return [];
  if (Array.isArray(rec.anyOf)) {
    const out: QuestionOption[] = [];
    for (const item of rec.anyOf) {
      const opt = asRecord(item);
      if (!opt || typeof opt.const !== 'string') continue;
      out.push({
        value: opt.const,
        label: typeof opt.title === 'string' && opt.title.trim() ? opt.title : opt.const,
        ...(typeof opt.description === 'string' && opt.description.trim() ? { description: opt.description } : {}),
      });
    }
    return out;
  }
  if (Array.isArray(rec.enum)) {
    return rec.enum
      .filter((item): item is string => typeof item === 'string')
      .map(value => ({ value, label: value }));
  }
  return [];
}

function parseSchemaProperty(
  name: string,
  schema: ElicitationPropertySchema,
  required: boolean,
): QuestionField {
  const rec = schema as Record<string, unknown>;
  const label = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : name;
  const description = typeof rec.description === 'string' && rec.description.trim() ? rec.description.trim() : undefined;

  if (schema.type === 'boolean') {
    return {
      kind: 'boolean',
      name,
      label,
      description,
      required,
      defaultValue: typeof rec.default === 'boolean' ? rec.default : undefined,
    };
  }
  if (schema.type === 'array') {
    const options = parseMultiSelectOptions(rec.items);
    return {
      kind: 'multi-select',
      name,
      label,
      description,
      required,
      options,
      minItems: typeof rec.minItems === 'number' ? rec.minItems : undefined,
      maxItems: typeof rec.maxItems === 'number' ? rec.maxItems : undefined,
      defaultValue: Array.isArray(rec.default) ? rec.default.filter((v): v is string => typeof v === 'string') : undefined,
    };
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return {
      kind: schema.type,
      name,
      label,
      description,
      required,
      defaultValue: typeof rec.default === 'number' && Number.isFinite(rec.default) ? String(rec.default) : undefined,
      minimum: typeof rec.minimum === 'number' ? rec.minimum : undefined,
      maximum: typeof rec.maximum === 'number' ? rec.maximum : undefined,
    };
  }

  const options = parseSingleSelectOptions(rec);
  if (options?.length) {
    return {
      kind: 'single-select',
      name,
      label,
      description,
      required,
      options,
      defaultValue: typeof rec.default === 'string' ? rec.default : undefined,
    };
  }
  return {
    kind: 'text',
    name,
    label,
    description,
    required,
    defaultValue: typeof rec.default === 'string' ? rec.default : undefined,
    minLength: typeof rec.minLength === 'number' ? rec.minLength : undefined,
    maxLength: typeof rec.maxLength === 'number' ? rec.maxLength : undefined,
    format: typeof rec.format === 'string' ? rec.format : undefined,
  };
}

/** Normalize an ACP `elicitation/create` request into renderable form fields or URL prompt state. */
export function parseElicitationRequest(request: CreateElicitationRequest): ParsedElicitation {
  if (request.mode === 'url' && 'url' in request && typeof request.url === 'string') {
    return {
      mode: 'url',
      title: 'Action required in browser',
      message: request.message,
      elicitationId: typeof request.elicitationId === 'string' ? request.elicitationId : '',
      url: request.url,
    };
  }
  if (request.mode === 'form' && 'requestedSchema' in request && request.requestedSchema) {
    const schema = request.requestedSchema as ElicitationSchema;
    const requiredSet = new Set(schema.required ?? []);
    const props = schema.properties ?? {};
    const fields = Object.entries(props).map(([name, propSchema]) =>
      parseSchemaProperty(name, propSchema, requiredSet.has(name)),
    );
    return {
      mode: 'form',
      title: schema.title?.trim() || 'Follow-up input requested',
      message: request.message,
      fields,
    };
  }
  return {
    mode: 'unsupported',
    title: 'Unsupported input request',
    message: request.message || 'The ACP agent sent an unsupported elicitation mode.',
  };
}

/** Build initial editable answer state for a list of follow-up question fields. */
export function createFollowUpSessionState(
  title: string,
  message: string,
  fields: readonly QuestionField[],
): FollowUpSessionState {
  const answers: Record<string, QuestionAnswerValue> = {};
  const customDrafts: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind === 'multi-select') {
      answers[field.name] = [...(field.defaultValue ?? [])];
    } else if (field.kind === 'boolean') {
      if (field.defaultValue !== undefined) answers[field.name] = field.defaultValue;
    } else if (field.kind === 'single-select') {
      if (field.defaultValue !== undefined) answers[field.name] = field.defaultValue;
      else if (field.options[0] && field.required) answers[field.name] = field.options[0].value;
      customDrafts[field.name] = '';
    } else {
      answers[field.name] = field.defaultValue ?? '';
    }
  }
  return {
    title,
    message,
    fields,
    activeFieldIdx: 0,
    answers,
    customDrafts,
    freeNote: '',
    draftCursors: {},
    optionCursors: {},
  };
}

/** Validate user answers against ACP elicitation schema constraints. */
export function validateElicitationAnswers(
  fields: readonly QuestionField[],
  state: FollowUpSessionState,
): { ok: true; content: Record<string, ElicitationContentValue> } | { ok: false; error: string; fieldIndex: number } {
  const content: Record<string, ElicitationContentValue> = {};
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const raw = state.answers[field.name];
    if (field.kind === 'boolean') {
      if (typeof raw === 'boolean') {
        content[field.name] = raw;
      } else if (field.required) {
        return { ok: false, error: `"${field.label}" requires Yes or No.`, fieldIndex: i };
      }
      continue;
    }
    if (field.kind === 'multi-select') {
      const selected = Array.isArray(raw) ? raw : [];
      if ((field.required && selected.length === 0) || (field.minItems !== undefined && selected.length < field.minItems)) {
        const min = Math.max(field.required ? 1 : 0, field.minItems ?? 0);
        return { ok: false, error: `"${field.label}" requires at least ${min} selection(s).`, fieldIndex: i };
      }
      if (field.maxItems !== undefined && selected.length > field.maxItems) {
        return { ok: false, error: `"${field.label}" allows at most ${field.maxItems} selection(s).`, fieldIndex: i };
      }
      if (selected.length > 0 || field.required) content[field.name] = selected;
      continue;
    }
    if (field.kind === 'single-select') {
      const custom = (state.customDrafts[field.name] ?? '').trim();
      const rawStr = typeof raw === 'string' && raw ? raw : '';
      const val = field.allowCustom && custom ? custom : rawStr;
      if (!val) {
        if (field.required) return { ok: false, error: `"${field.label}" requires a selection.`, fieldIndex: i };
        continue;
      }
      content[field.name] = val;
      continue;
    }
    const textVal = typeof raw === 'string' ? raw.trim() : '';
    if (!textVal) {
      if (field.required) return { ok: false, error: `"${field.label}" cannot be empty.`, fieldIndex: i };
      continue;
    }
    if (field.kind === 'number' || field.kind === 'integer') {
      const num = Number(textVal);
      if (!Number.isFinite(num) || (field.kind === 'integer' && !Number.isInteger(num))) {
        return { ok: false, error: `"${field.label}" must be a valid ${field.kind}.`, fieldIndex: i };
      }
      if (field.minimum !== undefined && num < field.minimum) {
        return { ok: false, error: `"${field.label}" must be >= ${field.minimum}.`, fieldIndex: i };
      }
      if (field.maximum !== undefined && num > field.maximum) {
        return { ok: false, error: `"${field.label}" must be <= ${field.maximum}.`, fieldIndex: i };
      }
      content[field.name] = num;
      continue;
    }
    if (field.minLength !== undefined && textVal.length < field.minLength) {
      return { ok: false, error: `"${field.label}" must be at least ${field.minLength} characters.`, fieldIndex: i };
    }
    if (field.maxLength !== undefined && textVal.length > field.maxLength) {
      return { ok: false, error: `"${field.label}" must be at most ${field.maxLength} characters.`, fieldIndex: i };
    }
    content[field.name] = textVal;
  }
  return { ok: true, content };
}

function normalizeQuestionItem(item: unknown, idx: number): QuestionField | undefined {
  const rec = asRecord(item);
  if (!rec) return undefined;
  const promptText =
    (typeof rec.question === 'string' && rec.question.trim()) ||
    (typeof rec.prompt === 'string' && rec.prompt.trim()) ||
    (typeof rec.label === 'string' && rec.label.trim()) ||
    (typeof rec.title === 'string' && rec.title.trim()) ||
    '';
  if (!promptText) return undefined;
  const name = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : `q${idx + 1}`;
  const rawOptions = Array.isArray(rec.options) ? rec.options : Array.isArray(rec.choices) ? rec.choices : undefined;
  if (rawOptions?.length) {
    const options: QuestionOption[] = [];
    for (const opt of rawOptions) {
      if (typeof opt === 'string' && opt.trim()) {
        options.push({ value: opt.trim(), label: opt.trim() });
      } else {
        const optRec = asRecord(opt);
        if (!optRec) continue;
        const label =
          (typeof optRec.label === 'string' && optRec.label.trim()) ||
          (typeof optRec.title === 'string' && optRec.title.trim()) ||
          (typeof optRec.value === 'string' && optRec.value.trim()) ||
          '';
        const value =
          (typeof optRec.value === 'string' && optRec.value.trim()) ||
          (typeof optRec.id === 'string' && optRec.id.trim()) ||
          label;
        if (!label) continue;
        options.push({
          value,
          label,
          ...(typeof optRec.description === 'string' && optRec.description.trim() ? { description: optRec.description.trim() } : {}),
        });
      }
    }
    if (options.length) {
      const multi = rec.is_multi_select === true || rec.multiSelect === true || rec.multiple === true;
      if (multi) {
        return {
          kind: 'multi-select',
          name,
          label: promptText,
          required: false,
          options,
        };
      }
      return {
        kind: 'single-select',
        name,
        label: promptText,
        required: false,
        options,
        allowCustom: true,
      };
    }
  }
  return {
    kind: 'text',
    name,
    label: promptText,
    required: false,
  };
}

/** Extract structured follow-up questions from `ask_question` or question-shaped tool inputs. */
export function extractToolFollowUpQuestions(call: ToolCallUpdate): { message: string; fields: QuestionField[] } | undefined {
  const input = asRecord(call.rawInput);
  if (!input) return undefined;
  const fields: QuestionField[] = [];
  if (Array.isArray(input.questions)) {
    input.questions.forEach((q, idx) => {
      const parsed = normalizeQuestionItem(q, idx);
      if (parsed) fields.push(parsed);
    });
  } else if (
    (typeof input.question === 'string' && input.question.trim()) ||
    (typeof input.prompt === 'string' && input.prompt.trim()) ||
    Array.isArray(input.options) ||
    Array.isArray(input.choices)
  ) {
    const parsed = normalizeQuestionItem(input, 0);
    if (parsed) fields.push(parsed);
  }
  if (!fields.length) return undefined;
  return {
    message: typeof input.message === 'string' && input.message.trim()
      ? input.message.trim()
      : 'Answer the follow-up question(s) below and send them back to Antigravity.',
    fields,
  };
}

function parseMarkdownChoiceOption(rawLine: string): QuestionOption | undefined {
  const match = /^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|[A-Za-z][.)]\s+)(.+)$/.exec(rawLine);
  if (!match) return undefined;
  const body = match[1]!.trim();
  if (!body || body.endsWith('?') || body.length > 180) return undefined;
  const splitMatch = /^\*\*([^*\n]{1,80})\*\*\s*(?:[:\-]+\s*(.+))?$/.exec(body);
  if (splitMatch) {
    const label = splitMatch[1]!.trim();
    const description = splitMatch[2]?.replace(/[*_`]+/g, '').trim();
    return {
      value: label,
      label,
      ...(description ? { description } : {}),
    };
  }
  const clean = body.replace(/[*_`]+/g, '').trim();
  if (!clean) return undefined;
  return { value: clean, label: clean };
}

/** Detect clear follow-up questions or multiple-choice prompts at the end of an agent markdown reply. */
export function extractMarkdownFollowUpQuestions(markdown: string): QuestionField[] {
  if (!markdown || !markdown.includes('?')) return [];
  const stripped = markdown.replace(/```[\s\S]*?```/g, ' ').trim();
  const tail = stripped.slice(-1_500);
  const lines = tail.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  // Check for a trailing question line immediately followed by 2..6 list choices.
  const trailingOptions: QuestionOption[] = [];
  let cursor = lines.length - 1;
  while (cursor >= 0 && trailingOptions.length < 6) {
    const parsedOpt = parseMarkdownChoiceOption(lines[cursor]!);
    if (!parsedOpt) break;
    trailingOptions.unshift(parsedOpt);
    cursor--;
  }
  if (trailingOptions.length >= 2 && cursor >= 0) {
    const heading = lines[cursor]!.replace(/^(?:\*\*|\*|>+\s*|#{1,3}\s+)+/, '').replace(/\*\*$/g, '').trim();
    if (heading.endsWith('?') && heading.length >= 8 && heading.length <= 220) {
      return [{
        kind: 'single-select',
        name: 'q1',
        label: heading,
        required: false,
        options: trailingOptions,
        allowCustom: true,
      }];
    }
  }

  const questions: string[] = [];
  for (let i = lines.length - 1; i >= 0 && questions.length < 4; i--) {
    const raw = lines[i]!;
    const clean = raw.replace(/^(?:\d+[.)]\s+|[-*+]\s+|>\s+|\*\*|\*)+/, '').replace(/\*\*$/g, '').trim();
    if (!clean.endsWith('?') || clean.length < 8 || clean.length > 220) {
      if (questions.length > 0 && !raw.startsWith('-') && !raw.startsWith('*') && !/^\d+[.)]\s/.test(raw)) break;
      continue;
    }
    questions.unshift(clean);
  }
  return questions.map((label, idx) => ({
    kind: 'text',
    name: `q${idx + 1}`,
    label,
    required: false,
  }));
}

/** Return the Tern focus target ID for the currently active follow-up input field, or null when a choice button leads. */
export function followUpFocusTarget(state: FollowUpSessionState | undefined): string | null {
  if (!state || !state.fields.length) return null;
  const field = state.fields[state.activeFieldIdx] ?? state.fields[0];
  if (!field) return null;
  if (field.kind === 'text' || field.kind === 'number' || field.kind === 'integer') {
    return `layer.panel.overlay-scroll.form.field-${field.name}.input-${field.name}`;
  }
  return null;
}

/** Format user modal answers into a crisp prompt reply sent to the ACP session. */
export function formatFollowUpPromptReply(state: FollowUpSessionState): string {
  const lines: string[] = [];
  for (const field of state.fields) {
    const ans = state.answers[field.name];
    const custom = (state.customDrafts[field.name] ?? '').trim();
    let display = '';
    if (field.kind === 'boolean' && typeof ans === 'boolean') {
      display = ans ? 'Yes' : 'No';
    } else if (field.kind === 'multi-select' && Array.isArray(ans) && ans.length) {
      display = ans.map(v => field.options.find(o => o.value === v)?.label ?? v).join(', ');
    } else if (field.kind === 'single-select') {
      if (custom) display = custom;
      else if (typeof ans === 'string' && ans) display = field.options.find(o => o.value === ans)?.label ?? ans;
    } else if (typeof ans === 'string' && ans.trim()) {
      display = ans.trim();
    }
    if (display) {
      lines.push(state.fields.length === 1 ? `${field.label}\nAnswer: ${display}` : `- ${field.label}: ${display}`);
    }
  }
  if (state.freeNote.trim()) {
    lines.push(lines.length ? `Additional context: ${state.freeNote.trim()}` : state.freeNote.trim());
  }
  return lines.join('\n');
}
