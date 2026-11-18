import { describe, expect, test } from 'bun:test';
import {
  createFollowUpSessionState,
  extractMarkdownFollowUpQuestions,
  extractToolFollowUpQuestions,
  followUpFocusTarget,
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
    expect(followUpFocusTarget(createFollowUpSessionState('Follow-up', '', fromMarkdown))).toBe(
      'layer.panel.overlay-scroll.form.field-q1.input-q1',
    );

    const mcMarkdown = extractMarkdownFollowUpQuestions([
      'Which release step should we run next?',
      '1. **Verify locally** - Run inside Tern first',
      '2. **Cut v0.2.2** - Commit, tag, and push release',
    ].join('\n'));
    expect(mcMarkdown).toHaveLength(1);
    expect(mcMarkdown[0]).toMatchObject({
      kind: 'single-select',
      name: 'q1',
      label: 'Which release step should we run next?',
      allowCustom: true,
    });
    if (mcMarkdown[0]?.kind === 'single-select') {
      expect(mcMarkdown[0].options).toEqual([
        { value: 'Verify locally', label: 'Verify locally', description: 'Run inside Tern first' },
        { value: 'Cut v0.2.2', label: 'Cut v0.2.2', description: 'Commit, tag, and push release' },
      ]);
    }
    const mcState = createFollowUpSessionState('Follow-up', '', mcMarkdown);
    expect(followUpFocusTarget(mcState)).toBeNull();

    // Preceding summary bullets must NOT become choices for the final question line.
    const summaryThenQuestion = extractMarkdownFollowUpQuestions([
      'Verification summary:',
      '- typecheck passed',
      '- tests passed',
      '',
      'Do you want to cut v0.2.2 now?',
    ].join('\n'));
    expect(summaryThenQuestion).toHaveLength(1);
    expect(summaryThenQuestion[0]?.kind).toBe('text');

    // Prompt + choices tool shape and custom text overriding required single-select default.
    const promptChoiceTool = extractToolFollowUpQuestions({
      toolCallId: 'tc-choice',
      name: 'ask_user',
      status: 'in_progress',
      rawInput: {
        prompt: 'Select environment',
        choices: ['dev', 'prod'],
      },
    });
    expect(promptChoiceTool?.fields[0]).toMatchObject({
      kind: 'single-select',
      label: 'Select environment',
    });
    const reqState = createFollowUpSessionState('Deploy', '', [{
      kind: 'single-select',
      name: 'env',
      label: 'Env',
      required: true,
      allowCustom: true,
      options: [{ value: 'staging', label: 'Staging' }, { value: 'prod', label: 'Prod' }],
    }]);
    reqState.customDrafts.env = 'canary';
    expect(validateElicitationAnswers(reqState.fields, reqState)).toEqual({
      ok: true,
      content: { env: 'canary' },
    });
  });
});
