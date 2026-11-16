import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const CLI_HELP = `agy-tern: native Tern frontend for the official Antigravity CLI

Usage: agy-tern [--cwd DIRECTORY] [--add-dir DIRECTORY]... [--agy EXECUTABLE]
                [--agent NAME] [--model MODEL] [--mode MODE] [--thinking LEVEL]
                [-c | --continue | --conversation SESSION_ID] [-i PROMPT | PROMPT]
       agy-tern --doctor [--json]

  --cwd DIRECTORY          Agent workspace (defaults to current directory)
  --add-dir DIRECTORY      Add an extra workspace root (repeatable)
  --agy EXECUTABLE         Official agy executable (defaults to agy on PATH)
  --agent NAME             Agent profile name passed to agy acp
  --model MODEL            Apply an initial ACP model ID or label after connecting
  --mode MODE              Apply an initial ACP session mode ID or label
  --thinking LEVEL         Apply an initial ACP thinking level ID or label (alias: --effort)
  -c, --continue           Resume/load the most recent conversation in this workspace
  --conversation ID        Resume/load a specific conversation ID on startup
  -i, --prompt-interactive Submit an initial prompt automatically once ready (or pass [PROMPT])
  --doctor                 Check local prerequisites without login or model requests
  --json                   Output --doctor diagnostics as JSON
  --help                   Show usage

In Tern: native chat over ACP. Other terminals: original agy UI.
In native chat: /account or /login opens official terminal login.
Official login outside native chat: agy acp --login
`;

export interface ParsedCliArgs {
  help: boolean;
  doctor: boolean;
  doctorJson: boolean;
  cwd: string;
  additionalDirectories: string[];
  agy?: string;
  agentName?: string;
  model?: string;
  mode?: string;
  thinking?: string;
  continueLast: boolean;
  conversationId?: string;
  initialPrompt?: string;
}

/** Parse and validate agy-tern CLI flags matching official agy CLI conventions. */
export function parseCliArgs(argv: readonly string[], baseCwd = process.cwd()): ParsedCliArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      cwd: { type: 'string' },
      'add-dir': { type: 'string', multiple: true },
      agy: { type: 'string' },
      agent: { type: 'string' },
      model: { type: 'string' },
      mode: { type: 'string' },
      thinking: { type: 'string' },
      effort: { type: 'string' },
      continue: { type: 'boolean', short: 'c' },
      conversation: { type: 'string' },
      'prompt-interactive': { type: 'string', short: 'i' },
      doctor: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    return {
      help: true,
      doctor: false,
      doctorJson: false,
      cwd: resolve(baseCwd),
      additionalDirectories: [],
      continueLast: false,
    };
  }
  if (values.json && !values.doctor) {
    throw new Error('--json is supported only with --doctor.');
  }
  if (values.continue && values.conversation) {
    throw new Error('Choose either --continue or --conversation, not both.');
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected extra arguments: ${positionals.slice(1).join(' ')}`);
  }
  if (positionals.length === 1 && values['prompt-interactive']) {
    throw new Error('Pass either -i/--prompt-interactive or a positional prompt, not both.');
  }

  const cwd = resolve(baseCwd, values.cwd ?? '.');
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a workspace directory: ${cwd}`);
  const additionalDirectories = (values['add-dir'] ?? []).map(dir => {
    const resolvedDir = resolve(cwd, dir);
    if (!statSync(resolvedDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not an additional workspace directory: ${dir}`);
    return resolvedDir;
  });

  return {
    help: false,
    doctor: !!values.doctor,
    doctorJson: !!values.json,
    cwd,
    additionalDirectories,
    agy: values.agy,
    agentName: values.agent,
    model: values.model,
    mode: values.mode,
    thinking: values.thinking ?? values.effort,
    continueLast: !!values.continue,
    conversationId: values.conversation,
    initialPrompt: values['prompt-interactive'] ?? positionals[0],
  };
}

/** Forward supported launch flags when falling back to the official interactive `agy` UI. */
export function buildFallbackAgyArgs(parsed: ParsedCliArgs): string[] {
  return [
    '--sandbox',
    ...parsed.additionalDirectories.flatMap(dir => ['--add-dir', dir]),
    ...(parsed.agentName ? ['--agent', parsed.agentName] : []),
    ...(parsed.model ? ['--model', parsed.model] : []),
    ...(parsed.mode ? ['--mode', parsed.mode] : []),
    ...(parsed.thinking ? ['--effort', parsed.thinking] : []),
    ...(parsed.continueLast ? ['--continue'] : []),
    ...(parsed.conversationId ? ['--conversation', parsed.conversationId] : []),
    ...(parsed.initialPrompt ? ['--prompt-interactive', parsed.initialPrompt] : []),
  ];
}
