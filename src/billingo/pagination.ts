// src/billingo/pagination.ts
import { z } from 'zod';

/** Laravel-paginator envelope, as returned by every Billingo list endpoint. */
export interface Paginated<T> {
  data: T[];
  total: number;
  per_page: number;
  current_page: number;
  last_page: number;
}

/**
 * Paging inputs shared by every list tool. Spread into a tool's input schema:
 * `inputSchema: { ...pageParamsShape, type: documentTypeSchema.optional() }`
 */
export const pageParamsShape = {
  page: z.number().int().min(1).optional().describe('Page number, starting at 1.'),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Results per page (1-100, default 25).'),
};

/** A one-line position summary, so the model knows whether to ask for more. */
export function summarizePage(
  page: Pick<Paginated<unknown>, 'total' | 'per_page' | 'current_page' | 'last_page'>,
): string {
  if (page.total === 0) return 'No results.';
  return `Page ${String(page.current_page)} of ${String(page.last_page)} (${String(page.total)} results total, ${String(page.per_page)} per page).`;
}
