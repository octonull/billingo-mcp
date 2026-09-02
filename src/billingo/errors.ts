// src/billingo/errors.ts

/** Base for every error this package throws. */
export class BillingoError extends Error {}

export interface ValidationIssue {
  field: string;
  message: string;
}

/** An error response from the Billingo API. */
export class BillingoApiError extends BillingoError {
  constructor(
    readonly status: number,
    message: string,
    readonly traceId?: string,
    readonly validationErrors: ValidationIssue[] = [],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** HTTP 429. `retryAfterMs` is set only when the response said so. */
export class BillingoRateLimitError extends BillingoApiError {
  constructor(
    status: number,
    message: string,
    traceId: string | undefined,
    validationErrors: ValidationIssue[],
    readonly retryAfterMs?: number,
  ) {
    super(status, message, traceId, validationErrors);
  }
}

/**
 * The PDF of a freshly created document is not ready yet. Per spec,
 * `/documents/{id}/download` (uniquely in this API) documents this as HTTP 202, not an
 * error status — 200 is the real file, 202 is "not yet". Billingo's documented remedy
 * is to retry later, optionally honouring `Retry-After`, which the 202 response
 * documents. `retryAfterMs` is set only when the response said so.
 */
export class BillingoPdfNotReadyError extends BillingoApiError {
  constructor(
    status: number,
    message: string,
    traceId: string | undefined,
    validationErrors: ValidationIssue[],
    readonly retryAfterMs?: number,
  ) {
    super(status, message, traceId, validationErrors);
  }
}

/**
 * HTTP status the download endpoint uses for "PDF not ready yet". Only that one
 * endpoint documents a 202 in the spec, so callers must opt in explicitly (see
 * `BillingoClient#getBinary`) — this is never inferred from status 202 generally.
 */
export const PDF_NOT_READY_STATUS = 202;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The 422 shape: { message, errors: [{ field, message }] } — no `error` wrapper. */
function readValidationIssues(body: Record<string, unknown>): ValidationIssue[] {
  if (!Array.isArray(body['errors'])) return [];
  return body['errors'].flatMap((issue: unknown) => {
    if (!isRecord(issue)) return [];
    const field = issue['field'];
    const message = issue['message'];
    if (typeof field !== 'string' || typeof message !== 'string') return [];
    return [{ field, message }];
  });
}

/**
 * Turns a Billingo error body into a typed error. Handles all three shapes the API
 * uses; see the spec doc. Never throws — an unparseable body still yields an error.
 */
export function parseErrorBody(
  status: number,
  body: unknown,
  retryAfterMs?: number,
): BillingoApiError {
  let message = '';
  let traceId: string | undefined;
  let validationErrors: ValidationIssue[] = [];

  if (isRecord(body)) {
    const wrapped = body['error'];
    if (isRecord(wrapped)) {
      // 4xx and 5xx: { error: { message, trace_id? } }
      if (typeof wrapped['message'] === 'string') message = wrapped['message'];
      if (typeof wrapped['trace_id'] === 'string') traceId = wrapped['trace_id'];
    } else if (typeof body['message'] === 'string') {
      // 422: { message, errors: [...] }
      message = body['message'];
      validationErrors = readValidationIssues(body);
    }
  }

  if (message === '') message = `Billingo API returned HTTP ${String(status)}`;

  let full = message;
  for (const issue of validationErrors) full += `\n  - ${issue.field}: ${issue.message}`;
  if (traceId !== undefined) full += `\n  trace_id: ${traceId} (quote this to Billingo support)`;

  if (status === 429)
    return new BillingoRateLimitError(status, full, traceId, validationErrors, retryAfterMs);
  // Callers only ever pass PDF_NOT_READY_STATUS (202) here from the scoped download-endpoint
  // code path in client.ts — see BillingoClient#getBinary. No other status is treated as
  // "not ready", so this never misclassifies a generic error that happens to be 202 elsewhere.
  if (status === PDF_NOT_READY_STATUS)
    return new BillingoPdfNotReadyError(status, full, traceId, validationErrors, retryAfterMs);
  return new BillingoApiError(status, full, traceId, validationErrors);
}
