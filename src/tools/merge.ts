// src/tools/merge.ts
import { z } from 'zod';
import type { BillingoClient } from '../billingo/client.js';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drops null and undefined values, recursively through plain objects. */
export function withoutNulls(value: Json): Json {
  const out: Json = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === null || inner === undefined) continue;
    out[key] = isObject(inner) ? withoutNulls(inner) : inner;
  }
  return out;
}

/** Keeps only `keys` of `record`. */
export function pick(record: Json, keys: readonly string[]): Json {
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]));
}

/**
 * Overlays `patch` on `base`. Plain objects merge key by key at every level, so
 * `{ address: { city } }` keeps the rest of the address; arrays and scalars replace.
 * A null or undefined patch value means "not given" and keeps the base value.
 */
export function mergePatch(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) continue;
    const current = out[key];
    // An object patch merges into an empty base when nothing is stored, so its nulls
    // still mean "keep" (here: leave out) instead of reaching the API.
    out[key] = isObject(value) ? mergePatch(isObject(current) ? current : {}, value) : value;
  }
  return out;
}

export interface PatchTarget {
  /** e.g. `/partners/12`; read with GET, written with PUT. */
  path: string;
  /** Fields the PUT accepts (the spec's write model). */
  writable: readonly string[];
  /** Turns the read model into the write model when the two differ (spendings). */
  toWritable?: (record: Json) => Json;
  /** Last adjustment of the merged body (products may carry only one price). */
  finalize?: (body: Json, patch: Json, current: Json) => Json;
}

/**
 * Changes only the fields in `patch`. Billingo's PUT on partners, products, bank
 * accounts and spendings replaces the whole record and clears every optional field it
 * leaves out (verified live 2026-10-14), so this reads the current record, overlays the
 * patch and sends the complete result. Verified live the same day: a record read back
 * and sent unchanged this way stays identical.
 *
 * The read and the write are two requests, so a change made in Billingo between them is
 * overwritten by the values read a moment earlier.
 */
export async function patchRecord(
  client: BillingoClient,
  target: PatchTarget,
  patch: Json,
): Promise<unknown> {
  const current = await client.get<Json>(target.path);
  const readable = target.toWritable === undefined ? current : target.toWritable(current);
  const base = withoutNulls(pick(readable, target.writable));
  let body = mergePatch(base, patch);
  if (target.finalize !== undefined) body = target.finalize(body, patch, readable);
  return client.put(target.path, { body });
}

/**
 * Makes a field optional and nullable at every level: an object's own fields become
 * optional and nullable too. Billingo returns null for unset fields, also inside nested
 * objects such as custom_billing_settings, so a record read back and sent as-is must be
 * accepted; mergePatch then treats every null as "keep".
 */
function nullishDeep(schema: z.ZodType): z.ZodType {
  let inner: z.ZodType = schema;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) {
    inner = inner.unwrap() as z.ZodType;
  }
  const result =
    inner instanceof z.ZodObject
      ? z.object(
          Object.fromEntries(
            Object.entries(inner.shape as Record<string, z.ZodType>).map(([key, field]) => [
              key,
              nullishDeep(field),
            ]),
          ),
        )
      : inner;
  const nullish = result.nullish();
  return schema.description === undefined ? nullish : nullish.describe(schema.description);
}

/**
 * The input shape of an update tool: every field optional and nullable, at every level,
 * because the tool keeps whatever is not given.
 */
export function patchShape<T extends Record<string, z.ZodType>>(
  shape: T,
): Record<keyof T, z.ZodType> {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, nullishDeep(schema)]),
  ) as Record<keyof T, z.ZodType>;
}

/** The shared sentence every update tool's description starts with. */
export function patchDescription(thing: string): string {
  return `Changes only the fields you send on an existing ${thing}; every other field keeps its current value. Billingo's API replaces the whole ${thing} on update, so this tool reads it first, applies your changes and sends the complete ${thing} back. Send just what changes; a missing or null field means "keep", and an array you send replaces the stored one. To empty an optional text field send ""; dates, numbers and links to other records cannot be emptied this way.`;
}
