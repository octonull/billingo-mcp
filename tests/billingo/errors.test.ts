// tests/billingo/errors.test.ts
import { describe, expect, it } from 'vitest';
import {
  BillingoApiError,
  BillingoPdfNotReadyError,
  BillingoRateLimitError,
  parseErrorBody,
} from '../../src/billingo/errors.js';

describe('parseErrorBody', () => {
  it('parses the 4xx shape: { error: { message } }', () => {
    const err = parseErrorBody(403, {
      error: { message: 'You do not have permission for this operation.' },
    });
    expect(err).toBeInstanceOf(BillingoApiError);
    expect(err.status).toBe(403);
    expect(err.message).toContain('You do not have permission');
    expect(err.traceId).toBeUndefined();
    expect(err.validationErrors).toEqual([]);
  });

  it('parses the 5xx shape and keeps trace_id, which support asks for', () => {
    const err = parseErrorBody(500, { error: { message: 'Internal error', trace_id: 'abc-123' } });
    expect(err.traceId).toBe('abc-123');
    expect(err.message).toContain('abc-123');
  });

  it('parses the 422 shape, which is NOT wrapped in `error`', () => {
    const err = parseErrorBody(422, {
      message: 'The given data was invalid.',
      errors: [
        { field: 'partner_id', message: 'The partner id field is required.' },
        { field: 'items', message: 'The items field is required.' },
      ],
    });
    expect(err.status).toBe(422);
    expect(err.validationErrors).toEqual([
      { field: 'partner_id', message: 'The partner id field is required.' },
      { field: 'items', message: 'The items field is required.' },
    ]);
    expect(err.message).toContain('partner_id');
    expect(err.message).toContain('The partner id field is required.');
  });

  it('returns a rate limit error for 429 and carries retryAfterMs', () => {
    const err = parseErrorBody(429, { error: { message: 'Too Many Attempts.' } }, 30_000);
    expect(err).toBeInstanceOf(BillingoRateLimitError);
    expect((err as BillingoRateLimitError).retryAfterMs).toBe(30_000);
  });

  it('exposes traceId on a rate-limit error, not just inside the message', () => {
    const err = parseErrorBody(
      429,
      { error: { message: 'Too Many Attempts.', trace_id: 'rl-999' } },
      30_000,
    );
    expect(err).toBeInstanceOf(BillingoRateLimitError);
    expect(err.traceId).toBe('rl-999');
    expect((err as BillingoRateLimitError).retryAfterMs).toBe(30_000);
  });

  it('carries validationErrors through the rate-limit branch, not just plain BillingoApiError', () => {
    const err = parseErrorBody(429, {
      message: 'Too Many Attempts.',
      errors: [{ field: 'foo', message: 'bar' }],
    });
    expect(err).toBeInstanceOf(BillingoRateLimitError);
    expect(err.validationErrors).toEqual([{ field: 'foo', message: 'bar' }]);
  });

  it('detects the not-yet-generated PDF as its own retryable error — the download endpoint documents this as HTTP 202, not an error status, with a flat { message } body (schema ClientError, not ClientErrorResponse)', () => {
    const err = parseErrorBody(202, {
      message: 'Document PDF has not generated yet. You should try to download again later.',
    });
    expect(err).toBeInstanceOf(BillingoPdfNotReadyError);
    expect(err.status).toBe(202);
    expect(err.message).toContain('not generated yet');
  });

  it('carries retryAfterMs through the PDF-not-ready branch, since the 202 response documents a Retry-After header', () => {
    const err = parseErrorBody(202, { message: 'Document PDF has not generated yet.' }, 5_000);
    expect(err).toBeInstanceOf(BillingoPdfNotReadyError);
    expect((err as BillingoPdfNotReadyError).retryAfterMs).toBe(5_000);
  });

  it('does not classify a 400 mentioning the PDF message as BillingoPdfNotReadyError — the spec only documents this as 202, so a 400 is an ordinary error', () => {
    const err = parseErrorBody(400, { error: { message: 'Document PDF has not generated yet.' } });
    expect(err).not.toBeInstanceOf(BillingoPdfNotReadyError);
    expect(err).toBeInstanceOf(BillingoApiError);
  });

  it('does not classify a 500 body merely mentioning the PDF message as BillingoPdfNotReadyError', () => {
    const err = parseErrorBody(500, { error: { message: 'Document PDF has not generated yet.' } });
    expect(err).not.toBeInstanceOf(BillingoPdfNotReadyError);
    expect(err).toBeInstanceOf(BillingoApiError);
  });

  it('does not classify a 200 body merely mentioning the PDF message as BillingoPdfNotReadyError', () => {
    const err = parseErrorBody(200, { error: { message: 'Document PDF has not generated yet.' } });
    expect(err).not.toBeInstanceOf(BillingoPdfNotReadyError);
    expect(err).toBeInstanceOf(BillingoApiError);
  });

  it('passes a quota-exhaustion 400 through as a plain API error without classifying it', () => {
    // The daily write quota returns 400, colliding with validation 400s. We must not guess.
    const err = parseErrorBody(400, { error: { message: 'API keret elfogyott.' } });
    expect(err).toBeInstanceOf(BillingoApiError);
    expect(err).not.toBeInstanceOf(BillingoPdfNotReadyError);
    expect(err.message).toContain('API keret elfogyott.');
  });

  it('survives a body that is not JSON-shaped at all', () => {
    const err = parseErrorBody(502, '<html>Bad Gateway</html>');
    expect(err.status).toBe(502);
    expect(err.message).toContain('502');
  });

  it('treats a non-array `errors` field as no validation issues', () => {
    const err = parseErrorBody(422, { message: 'Bad request.', errors: 'not-an-array' });
    expect(err.validationErrors).toEqual([]);
    expect(err.message).toContain('Bad request.');
  });

  it('drops validation-issue entries that are not objects', () => {
    const err = parseErrorBody(422, {
      message: 'Bad request.',
      errors: ['oops', 42, null],
    });
    expect(err.validationErrors).toEqual([]);
  });

  it('drops validation-issue entries missing a string field or message, keeping well-formed ones', () => {
    const err = parseErrorBody(422, {
      message: 'Bad request.',
      errors: [
        { field: 'a' }, // missing message
        { message: 'x' }, // missing field
        { field: 123, message: 'y' }, // field is not a string
        { field: 'ok', message: 'good' }, // well-formed
      ],
    });
    expect(err.validationErrors).toEqual([{ field: 'ok', message: 'good' }]);
  });

  it('falls back to the default message when the `error` wrapper has no string message', () => {
    const err = parseErrorBody(500, { error: { trace_id: 'no-message-1' } });
    expect(err.message).toContain('Billingo API returned HTTP 500');
    expect(err.traceId).toBe('no-message-1');
  });

  it('ignores a non-string trace_id rather than surfacing garbage in the message', () => {
    const err = parseErrorBody(500, { error: { message: 'Oops', trace_id: 12345 } });
    expect(err.traceId).toBeUndefined();
    expect(err.message).not.toContain('trace_id');
  });

  it('falls back to the default message for a body matching none of the known shapes', () => {
    const err = parseErrorBody(500, { foo: 'bar' });
    expect(err.message).toBe('Billingo API returned HTTP 500');
    expect(err.validationErrors).toEqual([]);
    expect(err.traceId).toBeUndefined();
  });
});
