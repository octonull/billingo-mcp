// tests/tools/registry.test.ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, errorResult, filterByScope, jsonResult } from '../../src/tools/registry.js';
import type { AnyToolDefinition } from '../../src/tools/registry.js';

const readTool = defineTool({
  name: 'billingo_read_thing',
  scope: 'read',
  title: 'Read thing',
  description: 'Reads a thing.',
  inputSchema: { id: z.number().int() },
  annotations: { readOnlyHint: true },
  handler: () => Promise.resolve(jsonResult({ ok: true })),
});

const writeTool = defineTool({
  name: 'billingo_write_thing',
  scope: 'write',
  title: 'Write thing',
  description: 'Writes a thing.',
  inputSchema: { name: z.string() },
  annotations: { destructiveHint: false },
  handler: () => Promise.resolve(jsonResult({ ok: true })),
});

const tools: AnyToolDefinition[] = [readTool, writeTool];

describe('filterByScope', () => {
  it('hides write tools by default', () => {
    const visible = filterByScope(tools, false);
    expect(visible.map((t) => t.name)).toEqual(['billingo_read_thing']);
  });

  it('exposes every tool when writes are allowed', () => {
    const visible = filterByScope(tools, true);
    expect(visible.map((t) => t.name)).toEqual(['billingo_read_thing', 'billingo_write_thing']);
  });

  it('returns read tools unchanged when there are no write tools', () => {
    expect(filterByScope([readTool], false)).toHaveLength(1);
  });

  it('returns a copy of the input array when writes are allowed, not the array itself', () => {
    const visible = filterByScope(tools, true);
    expect(visible).not.toBe(tools);

    visible.push(readTool);
    expect(tools).toHaveLength(2);
  });
});

describe('jsonResult', () => {
  it('serializes the value as pretty JSON text', () => {
    const result = jsonResult({ id: 1 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: 'text', text: '{\n  "id": 1\n}' });
  });

  it('puts the summary before the JSON so the model reads it first', () => {
    const result = jsonResult({ id: 1 }, 'Page 1 of 3.');
    expect(result.content[0]).toEqual({ type: 'text', text: 'Page 1 of 3.' });
    expect(result.content[1]).toEqual({ type: 'text', text: '{\n  "id": 1\n}' });
  });

  it('renders a null value (e.g. a 204 response) as an explicit success message, not the literal string "null"', () => {
    const result = jsonResult(null);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({
      type: 'text',
      text: expect.not.stringMatching(/^null$/) as string,
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Success') as string });
  });
});

describe('jsonResult structuredContent', () => {
  it('mirrors an object result as structuredContent', () => {
    expect(jsonResult({ id: 1 }).structuredContent).toEqual({ id: 1 });
  });

  it('adds no structuredContent for an array or an empty body — the protocol requires an object', () => {
    expect(jsonResult([{ id: 1 }]).structuredContent).toBeUndefined();
    expect(jsonResult(null).structuredContent).toBeUndefined();
  });

  it('uses an explicit wrapper when the tool passes one', () => {
    const result = jsonResult([{ price: 1 }], undefined, { payments: [{ price: 1 }] });
    expect(result.structuredContent).toEqual({ payments: [{ price: 1 }] });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('"price": 1') as string,
    });
  });
});

describe('errorResult', () => {
  it('marks the result as an error and keeps the message', () => {
    const result = errorResult('Nope.');
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Nope.' });
  });

  it('adds the error details as a JSON block a script can branch on', () => {
    const result = errorResult('Not there.', { code: 'not_found', retryable: false, status: 404 });
    const second = result.content[1];
    expect(second?.type).toBe('text');
    expect(JSON.parse((second as { text: string }).text)).toEqual({
      error: { code: 'not_found', retryable: false, status: 404, message: 'Not there.' },
    });
  });

  it('puts nothing in structuredContent — the SDK client would validate it against the outputSchema', () => {
    expect(errorResult('x').structuredContent).toBeUndefined();
  });
});
