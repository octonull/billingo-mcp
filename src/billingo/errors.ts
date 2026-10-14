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

/**
 * Machine-readable error codes for tool results. A model reads the message; a script in a
 * code-mode sandbox branches on the code, so the codes are part of the public contract.
 */
export type ToolErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'nav_connection_required'
  | 'subscription_required'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'rate_limited'
  | 'pdf_not_ready'
  | 'server_error'
  | 'api_error'
  | 'client_error'
  | 'invalid_arguments'
  | 'export_pending'
  | 'export_failed';

/** The `error` object in the JSON block of a failed tool call (see errorResult). */
export interface ToolErrorDetails {
  code: ToolErrorCode;
  /**
   * True when repeating the same call is safe and may succeed. Never true for a write
   * whose outcome is unknown: a 5xx on POST /documents may still have issued the invoice.
   */
  retryable: boolean;
  /**
   * Set on a server error from a non-idempotent call: the change may or may not have been
   * made. Read the state back (for documents: by vendor_id) before trying again.
   */
  outcome_unknown?: boolean;
  /** HTTP status of the Billingo response, when there was one. */
  status?: number;
  retry_after_seconds?: number;
  /** Per-field problems of a 422. */
  fields?: ValidationIssue[];
  trace_id?: string;
}

/**
 * Billingo answers 401 both for a bad API key and, on the tax-number lookup, for an
 * account without a live NAV connection. Verified live 2026-10-14: the second carries the
 * message "please ensure you have a live connection to NAV". Telling them apart keeps a
 * model from asking the user for a new API key when the key is fine.
 */
const NAV_CONNECTION_MESSAGE = /connection to NAV/i;

function codeForStatus(status: number, message: string): ToolErrorCode {
  if (status === 400) return 'bad_request';
  if (status === 401)
    return NAV_CONNECTION_MESSAGE.test(message) ? 'nav_connection_required' : 'unauthorized';
  if (status === 402) return 'subscription_required';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 422) return 'validation_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'api_error';
}

/**
 * Maps an error this package throws to the details of a tool result. `idempotent` is the
 * tool's idempotentHint: a 5xx is only retryable when repeating the call cannot duplicate
 * its effect. (The client itself is stricter: it retries only GETs, and only on 429 and
 * an unready PDF.)
 */
export function describeError(
  error: BillingoError,
  { idempotent }: { idempotent: boolean } = { idempotent: false },
): ToolErrorDetails {
  if (!(error instanceof BillingoApiError)) return { code: 'client_error', retryable: false };
  const details: ToolErrorDetails = {
    code: codeForStatus(error.status, error.message),
    retryable: false,
    status: error.status,
  };
  if (error instanceof BillingoPdfNotReadyError) {
    details.code = 'pdf_not_ready';
    details.retryable = true;
  }
  if (error instanceof BillingoRateLimitError) details.retryable = true;
  if (error.status >= 500) {
    if (idempotent) details.retryable = true;
    else details.outcome_unknown = true;
  }
  const retryAfterMs =
    error instanceof BillingoRateLimitError || error instanceof BillingoPdfNotReadyError
      ? error.retryAfterMs
      : undefined;
  if (retryAfterMs !== undefined) details.retry_after_seconds = Math.ceil(retryAfterMs / 1000);
  if (error.validationErrors.length > 0) details.fields = error.validationErrors;
  if (error.traceId !== undefined) details.trace_id = error.traceId;
  return details;
}
