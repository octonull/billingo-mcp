// src/config.ts
import { z } from 'zod';

const DEFAULT_BASE_URL = 'https://api.billingo.hu/v3';

/**
 * Only explicit affirmatives enable writes. An unrecognized value means false:
 * a typo must never be the reason an LLM can issue invoices.
 */
export function parseBooleanFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

/** Turns a zod error into a message naming the offending variable. */
function describe(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

const stdioSchema = z.object({
  BILLINGO_API_KEY: z.string().min(1, 'is required (your Billingo API key)'),
  BILLINGO_BASE_URL: z.url('must be a valid URL').default(DEFAULT_BASE_URL),
  BILLINGO_ALLOW_WRITE: z.string().optional(),
});

export interface StdioConfig {
  apiKey: string;
  baseUrl: string;
  allowWrite: boolean;
}

export function loadStdioConfig(env: NodeJS.ProcessEnv): StdioConfig {
  const parsed = stdioSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration — ${describe(parsed.error)}`);
  return {
    apiKey: parsed.data.BILLINGO_API_KEY,
    baseUrl: parsed.data.BILLINGO_BASE_URL,
    allowWrite: parseBooleanFlag(parsed.data.BILLINGO_ALLOW_WRITE),
  };
}

const httpSchema = z.object({
  BILLINGO_BASE_URL: z.url('must be a valid URL').default(DEFAULT_BASE_URL),
  PORT: z.coerce.number('must be a number').int().min(1).max(65535).default(3000),
  BILLINGO_ALLOWED_HOSTS: z.string().optional(),
  COMMIT_SHA: z.string().optional(),
  BUILD_VERSION: z.string().optional(),
});

export interface HttpConfig {
  baseUrl: string;
  port: number;
  /** Undefined disables DNS-rebinding protection; set it when hosting publicly. */
  allowedHosts: string[] | undefined;
  /** Baked in at image build time (see Dockerfile); undefined outside a built image. */
  commitSha: string | undefined;
  /** The npm/release version, set only when the built commit matches a release tag. */
  buildVersion: string | undefined;
}

/** Docker `ARG X=` with no value passed in still sets `ENV X=""`, not an unset var. */
function undefinedIfEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export function loadHttpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const parsed = httpSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration — ${describe(parsed.error)}`);
  const hosts = parsed.data.BILLINGO_ALLOWED_HOSTS;
  return {
    baseUrl: parsed.data.BILLINGO_BASE_URL,
    port: parsed.data.PORT,
    allowedHosts:
      hosts === undefined
        ? undefined
        : hosts
            .split(',')
            .map((h) => h.trim())
            .filter((h) => h !== ''),
    commitSha: undefinedIfEmpty(parsed.data.COMMIT_SHA),
    buildVersion: undefinedIfEmpty(parsed.data.BUILD_VERSION),
  };
}
