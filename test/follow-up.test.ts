import { describe, expect, test } from 'bun:test';
import {
  createFollowUpSessionState,
  extractMarkdownFollowUpQuestions,
  extractToolFollowUpQuestions,
  formatFollowUpPromptReply,
  parseElicitationRequest,
  validateElicitationAnswers,
} from '../src/follow-up';

describe('follow-up question and ACP elicitation helpers', () => {
  test('parses ACP form elicitation schemas and validates required and typed constraints', () => {
    const parsed = parseElicitationRequest({
      sessionId: 'sess-1',
      mode: 'form',
      message: 'Choose deployment target and replicas.',
      requestedSchema: {
        type: 'object',
        title: 'Deploy options',
        required: ['env', 'replicas'],
        properties: {
          env: {
            type: 'string',
            title: 'Environment',
            oneOf: [
              { const: 'staging', title: 'Staging' },
              { const: 'prod', title: 'Production' },
            ],
          },
          replicas: {
            type: 'integer',
            title: 'Replica count',
            minimum: 1,
            maximum: 8,
            default: 2,
          },
          dryRun: {
            type: 'boolean',
            title: 'Dry run',
            default: true,
          },
        },
      },
    });

    expect(parsed.mode).toBe('form');
    if (parsed.mode !== 'form') return;
    expect(parsed.title).toBe('Deploy options');
    expect(parsed.fields).toHaveLength(3);

    const state = createFollowUpSessionState(parsed.title, parsed.message, parsed.fields);
    expect(state.answers.env).toBe('staging');
    expect(state.answers.replicas).toBe('2');
    expect(state.answers.dryRun).toBe(true);

    const valid = validateElicitationAnswers(parsed.fields, state);
    expect(valid).toEqual({
      ok: true,
      content: { env: 'staging', replicas: 2, dryRun: true },
    });

    state.answers.replicas = '12';
    const outOfRange = validateElicitationAnswers(parsed.fields, state);
    expect(outOfRange.ok).toBe(false);
  });

  test('parses ACP URL elicitation requests cleanly', () => {
    const parsed = parseElicitationRequest({
      sessionId: 'sess-1',
      mode: 'url',
      elicitationId: 'elicit-99',
      url: 'https://example.com/authorize',
      message: 'Finish authorization in your browser.',
    });
    expect(parsed).toEqual({
      mode: 'url',
      title: 'Action required in browser',
      message: 'Finish authorization in your browser.',
      elicitationId: 'elicit-99',
      url: 'https://example.com/authorize',
    });
  });

  test('extracts follow-up questions from tool inputs and agent markdown replies', () => {
    const fromTool = extractToolFollowUpQuestions({
      toolCallId: 'tc-q',
      name: 'ask_question',
      status: 'completed',
      rawInput: {
        questions: [
          {
            question: 'Which build flavor should we verify?',
            options: [{ label: 'Debug', description: 'Faster build' }, { label: 'Release' }],
          },
        ],
      },
    });
    expect(fromTool?.fields).toHaveLength(1);
    const st = createFollowUpSessionState('Follow-up', fromTool!.message, fromTool!.fields);
    st.answers.q1 = 'Release';
    st.freeNote = 'Skip UI screenshot step.';
    expect(formatFollowUpPromptReply(st)).toBe('Which build flavor should we verify?\nAnswer: Release\nAdditional context: Skip UI screenshot step.');

    const fromMarkdown = extractMarkdownFollowUpQuestions([
      'Here is the summary.',
      '',
      '1. Should I commit the workflow files now?',
      '2. Do you want a v0.1.0 release tag created?',
    ].join('\n'));
    expect(fromMarkdown.map(q => q.label)).toEqual([
      'Should I commit the workflow files now?',
      'Do you want a v0.1.0 release tag created?',
    ]);
  });
});
