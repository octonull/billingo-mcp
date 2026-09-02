// src/billingo/client.ts
import { parseErrorBody, BillingoRateLimitError, BillingoPdfNotReadyError } from './errors.js';

export interface BillingoClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Retries for retryable failures on idempotent requests. Default 3. */
  maxRetries?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  query?: Record<string, unknown> | undefined;
  body?: unknown;
}

const DEFAULT_BASE_URL = 'https://api.billingo.hu/v3';

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Query values are expected to be string/number/boolean (or arrays thereof); anything else is dropped. */
function toQueryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function buildQuery(query: Record<string, unknown> | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const str = toQueryString(item);
        if (str !== undefined) params.append(key, str);
      }
    } else {
      const str = toQueryString(value);
      if (str !== undefined) params.append(key, str);
    }
  }
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
}

/** `Retry-After` may be seconds or an HTTP date. Returns undefined if absent or unparseable. */
function readRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

export class BillingoClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: BillingoClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.#requestJson<T>('GET', path, opts);
  }
  post<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.#requestJson<T>('POST', path, opts);
  }
  put<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.#requestJson<T>('PUT', path, opts);
  }
  delete<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.#requestJson<T>('DELETE', path, opts);
  }

  /**
   * `notReadyStatus`, when given, is a status that is otherwise a 2xx success (so
   * `response.ok` is true) but should be treated as a retryable "not ready" error
   * instead of being returned as file bytes. Only pass this for an endpoint whose
   * spec documents that status for that meaning — e.g. PDF_NOT_READY_STATUS (202) for
   * `/documents/{id}/download`. Leaving it unset means every 2xx is real content, which
   * is correct for every other binary endpoint (e.g. POS print never returns 202).
   */
  async getBinary(
    path: string,
    opts: RequestOptions = {},
    notReadyStatus?: number,
  ): Promise<{ data: Uint8Array; contentType: string }> {
    const response = await this.#send(
      'GET',
      path,
      opts,
      'application/octet-stream',
      notReadyStatus,
    );
    const buffer = await response.arrayBuffer();
    return {
      data: new Uint8Array(buffer),
      contentType: response.headers.get('Content-Type') ?? 'application/octet-stream',
    };
  }

  async #requestJson<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
    const response = await this.#send(method, path, opts, 'application/json');
    if (response.status === 204) return null as T;
    const text = await response.text();
    if (text === '') return null as T;
    return JSON.parse(text) as T;
  }

  /**
   * Sends the request, retrying where safe, and throws a typed error on failure.
   * `notReadyStatus`: see `getBinary` — a 2xx status that should be routed through the
   * error/retry path instead of being returned as a successful response.
   */
  async #send(
    method: string,
    path: string,
    opts: RequestOptions,
    accept: string,
    notReadyStatus?: number,
  ): Promise<Response> {
    const url = `${this.#baseUrl}${path}${buildQuery(opts.query)}`;
    const headers: Record<string, string> = { 'X-API-KEY': this.#apiKey, Accept: accept };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    let attempt = 0;
    for (;;) {
      const response = await this.#fetch(url, init);
      if (response.ok && response.status !== notReadyStatus) return response;

      const error = await this.#toError(response);
      if (!this.#shouldRetry(method, error, attempt)) throw error;

      await this.#sleep(this.#backoffMs(attempt, error));
      attempt += 1;
    }
  }

  async #toError(response: Response): Promise<Error> {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON body (e.g. an HTML error page); parseErrorBody handles it.
    }
    return parseErrorBody(response.status, body, readRetryAfterMs(response));
  }

  /**
   * Only idempotent requests are retried. A retried POST /documents would issue a
   * second invoice — reported to NAV, and unfixable.
   */
  #shouldRetry(method: string, error: Error, attempt: number): boolean {
    if (attempt >= this.#maxRetries) return false;
    if (method !== 'GET') return false;
    if (error instanceof BillingoRateLimitError) return true;
    if (error instanceof BillingoPdfNotReadyError) return true;
    return false;
  }

  #backoffMs(attempt: number, error: Error): number {
    if (error instanceof BillingoRateLimitError && error.retryAfterMs !== undefined) {
      return error.retryAfterMs;
    }
    if (error instanceof BillingoPdfNotReadyError && error.retryAfterMs !== undefined) {
      return error.retryAfterMs;
    }
    const base = 500 * 2 ** attempt;
    return base + Math.random() * 250; // jitter, so parallel clients don't resonate
  }
}
