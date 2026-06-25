// Tool input validation + content-free error mapping.

import { ProviderUnavailableError, RateLimitError } from '@muninhq/engine';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildServerInstructions } from './instructions';
import { TOOL_INPUT_SHAPES, buildServer, toolErrorMessage } from './server';
import { testConfiguration } from './test-fixtures';
import type { ToolDeps } from './tools/types';

describe('tool input shapes', () => {
  it('munin_retrieve_context requires a non-empty question; subject optional', () => {
    const schema = z.object(TOOL_INPUT_SHAPES.munin_retrieve_context);
    expect(schema.safeParse({ question: 'q' }).success).toBe(true);
    expect(schema.safeParse({ question: 'q', subject: 's' }).success).toBe(true);
    expect(schema.safeParse({ question: '' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ question: 42 }).success).toBe(false);
  });

  it('munin_ask requires a non-empty question; subject + pick optional but non-empty', () => {
    const schema = z.object(TOOL_INPUT_SHAPES.munin_ask);
    expect(schema.safeParse({ question: 'q' }).success).toBe(true);
    expect(schema.safeParse({ question: 'q', subject: 'A. Example' }).success).toBe(true);
    expect(schema.safeParse({ question: 'q', subject: 'A. Example', pick: 'tok' }).success).toBe(
      true,
    );
    expect(schema.safeParse({ question: '' }).success).toBe(false);
    expect(schema.safeParse({ question: 'q', subject: '' }).success).toBe(false);
    expect(schema.safeParse({ question: 'q', pick: '' }).success).toBe(false);
  });

  it('munin_gather_entity requires a subject; pick optional but non-empty', () => {
    const schema = z.object(TOOL_INPUT_SHAPES.munin_gather_entity);
    expect(schema.safeParse({ subject: 'A. Example' }).success).toBe(true);
    expect(schema.safeParse({ subject: 'A. Example', pick: 'tok' }).success).toBe(true);
    expect(schema.safeParse({ subject: '' }).success).toBe(false);
    expect(schema.safeParse({ subject: 'x', pick: '' }).success).toBe(false);
  });

  it('munin_get_document requires a documentId', () => {
    const schema = z.object(TOOL_INPUT_SHAPES.munin_get_document);
    expect(schema.safeParse({ documentId: 'abc' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('munin_status takes no input', () => {
    const schema = z.object(TOOL_INPUT_SHAPES.munin_status);
    expect(schema.safeParse({}).success).toBe(true);
  });
});

describe('toolErrorMessage', () => {
  it('maps typed provider errors to named, content-free messages', () => {
    expect(toolErrorMessage(new RateLimitError('p'))).toMatch(/rate-limited/);
    expect(toolErrorMessage(new ProviderUnavailableError('p'))).toMatch(/unavailable/);
  });

  it('never echoes the underlying error content', () => {
    const messages = [
      toolErrorMessage(new RateLimitError('p', 1000, new Error('SECRET-INTERNAL'))),
      toolErrorMessage(new Error('SECRET-INTERNAL')),
      toolErrorMessage('SECRET-INTERNAL'),
    ];
    for (const m of messages) expect(m).not.toContain('SECRET-INTERNAL');
  });

  it('maps unknown errors to a generic message pointing at the stderr log', () => {
    expect(toolErrorMessage(new Error('boom'))).toMatch(/stderr/);
  });
});

describe('buildServer', () => {
  // Only deps.configuration is read at build time (descriptions + instructions);
  // the tool handlers are closures that are never invoked here.
  const deps = { configuration: testConfiguration() } as unknown as ToolDeps;

  it('wires the configuration-sourced server-level instructions into the McpServer', () => {
    const server = buildServer(deps);
    // White-box: the SDK Server stores the initialize-response instructions on
    // `_instructions`. Asserting it here guards against a regression that drops the
    // McpServer constructor's options argument (silently losing session-start bias).
    const wired = (server.server as unknown as { _instructions?: string })._instructions;
    expect(wired).toBe(buildServerInstructions(testConfiguration()));
    expect(wired).toContain('test records'); // terminology-sourced, not hard-coded
  });
});
