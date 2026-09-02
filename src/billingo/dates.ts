// src/billingo/dates.ts
import { z } from 'zod';

/** ISO date, the only format the API accepts. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date, e.g. "2026-01-31"');
