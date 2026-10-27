// tests/tools/merge.test.ts
import { describe, expect, it } from 'vitest';
import { mergePatch, pick, withoutNulls } from '../../src/tools/merge.js';

describe('mergePatch', () => {
  it('overlays scalars, replaces arrays and merges plain objects at every level', () => {
    const base = { a: 1, list: [1, 2], nested: { x: 1, deeper: { y: 1, z: 1 } } };
    expect(mergePatch(base, { a: 2, list: [3], nested: { deeper: { z: 2 } } })).toEqual({
      a: 2,
      list: [3],
      nested: { x: 1, deeper: { y: 1, z: 2 } },
    });
  });

  it('treats null and undefined in the patch as "not given"', () => {
    expect(mergePatch({ a: 1, b: 2 }, { a: null, b: undefined })).toEqual({ a: 1, b: 2 });
  });

  it('sets a key the base does not have', () => {
    expect(mergePatch({ a: 1 }, { b: 'x' })).toEqual({ a: 1, b: 'x' });
  });

  it('does not change its inputs', () => {
    const base = { nested: { x: 1 } };
    mergePatch(base, { nested: { x: 2 } });
    expect(base).toEqual({ nested: { x: 1 } });
  });
});

describe('withoutNulls and pick', () => {
  it('drops nulls recursively and keeps falsy values that are not null', () => {
    expect(withoutNulls({ a: null, b: '', c: 0, d: false, e: { f: null, g: 1 } })).toEqual({
      b: '',
      c: 0,
      d: false,
      e: { g: 1 },
    });
  });

  it('keeps only the named keys that exist', () => {
    expect(pick({ a: 1, b: 2, id: 3 }, ['a', 'c'])).toEqual({ a: 1 });
  });
});
