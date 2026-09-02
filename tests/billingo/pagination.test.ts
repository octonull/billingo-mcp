// tests/billingo/pagination.test.ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pageParamsShape, summarizePage } from '../../src/billingo/pagination.js';

describe('pageParamsShape', () => {
  const schema = z.object(pageParamsShape);

  it('accepts an empty input — both params are optional', () => {
    expect(schema.parse({})).toEqual({});
  });

  it('accepts valid paging', () => {
    expect(schema.parse({ page: 2, per_page: 50 })).toEqual({ page: 2, per_page: 50 });
  });

  it('rejects a zero or negative page', () => {
    expect(() => schema.parse({ page: 0 })).toThrow();
    expect(() => schema.parse({ page: -1 })).toThrow();
  });

  it('rejects a per_page above the API maximum of 100', () => {
    expect(() => schema.parse({ per_page: 101 })).toThrow();
  });

  it('rejects a non-integer page', () => {
    expect(() => schema.parse({ page: 1.5 })).toThrow();
  });
});

describe('summarizePage', () => {
  it('describes the position within the result set', () => {
    const page = { data: [{ id: 1 }], total: 120, per_page: 25, current_page: 2, last_page: 5 };
    expect(summarizePage(page)).toBe('Page 2 of 5 (120 results total, 25 per page).');
  });

  it('states plainly when there is nothing to page through', () => {
    const page = { data: [], total: 0, per_page: 25, current_page: 1, last_page: 1 };
    expect(summarizePage(page)).toBe('No results.');
  });
});
