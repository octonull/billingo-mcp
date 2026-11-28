// tests/tools/safeguards.test.ts
import { describe, expect, it } from 'vitest';
import { allTools } from '../../src/tools/index.js';
import { DuplicateGuard, SAFEGUARDS, stableStringify } from '../../src/tools/safeguards.js';

describe('safeguard coverage', () => {
  it('decides for every write tool that is destructive or not idempotent', () => {
    const risky = allTools.filter(
      (t) =>
        t.scope === 'write' &&
        (t.annotations.destructiveHint === true || t.annotations.idempotentHint !== true),
    );
    const missing = risky.map((t) => t.name).filter((name) => !(name in SAFEGUARDS));
    expect(missing).toEqual([]);
  });

  it('only names tools that exist, and never a read tool', () => {
    const byName = new Map(allTools.map((t) => [t.name, t]));
    for (const name of Object.keys(SAFEGUARDS)) {
      expect(byName.get(name)?.scope, name).toBe('write');
    }
  });

  it('confirms every tool that reports to NAV, sends e-mail or deletes', () => {
    for (const name of [
      'billingo_create_document',
      'billingo_create_receipt',
      'billingo_finalize_draft',
      'billingo_finalize_receipt_draft',
      'billingo_create_document_from_proforma',
      'billingo_create_modification_document',
      'billingo_cancel_document',
      'billingo_send_document',
      'billingo_update_payment',
      'billingo_delete_document',
      'billingo_delete_payment',
      'billingo_delete_partner',
      'billingo_delete_product',
      'billingo_delete_spending',
      'billingo_delete_bank_account',
    ]) {
      expect(SAFEGUARDS[name]?.confirm, name).toBeTypeOf('function');
    }
  });
});

describe('confirmation messages', () => {
  const confirm = (tool: string, args: Record<string, unknown>): string | undefined =>
    SAFEGUARDS[tool]?.confirm?.(args);

  it('describes an invoice so the user can recognise it', () => {
    const message = confirm('billingo_create_document', {
      type: 'invoice',
      partner_id: 42,
      currency: 'HUF',
      items: [
        { name: 'Consulting', quantity: 3, unit_price: 10000, unit_price_type: 'net' },
        { product_id: 7, quantity: 1 },
      ],
    });
    expect(message).toContain('invoice for partner #42, HUF');
    expect(message).toContain('Consulting × 3 at 10000 (net)');
    expect(message).toContain('product #7 × 1');
    expect(message).toContain('NAV');
  });

  it('does not ask for a draft or a proforma, which NAV never sees', () => {
    expect(confirm('billingo_create_document', { type: 'draft' })).toBeUndefined();
    expect(confirm('billingo_create_document', { type: 'proforma' })).toBeUndefined();
    expect(confirm('billingo_create_receipt', { type: 'draft' })).toBeUndefined();
  });

  it('shortens a long item list', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ name: `L${String(i)}`, quantity: 1 }));
    expect(confirm('billingo_create_document', { type: 'invoice', items })).toContain(
      '8 items: L0 × 1, L1 × 1, L2 × 1, L3 × 1, L4 × 1, and 3 more',
    );
  });

  it('names the recipients of an e-mail, or says it goes to the partner', () => {
    expect(confirm('billingo_send_document', { id: 5, emails: ['a@b.hu'] })).toContain('to a@b.hu');
    expect(confirm('billingo_send_document', { id: 5 })).toContain("partner's e-mail");
  });

  it('builds a message for every confirmed tool from plain arguments', () => {
    for (const [name, guard] of Object.entries(SAFEGUARDS)) {
      if (guard.confirm === undefined) continue;
      const message = guard.confirm({ id: 1, type: 'invoice', items: [], payments: [] });
      expect(message, name).toMatch(/\?/);
    }
  });
});

describe('stableStringify', () => {
  it('ignores key order and undefined values', () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: 1 }], c: undefined })).toBe(
      stableStringify({ a: [{ x: 1, y: 2 }], b: 1 }),
    );
  });
});

describe('DuplicateGuard', () => {
  const key = DuplicateGuard.key('t', 'billingo_create_document', { type: 'invoice' });

  it('refuses a repeat while the first call runs, and after it succeeded', () => {
    let now = 1_000;
    const guard = new DuplicateGuard({ windowMs: 60_000, now: () => now });
    expect(guard.check(key)).toEqual({ duplicate: false });
    const first = guard.begin(key);
    expect(guard.check(key)).toMatchObject({ duplicate: true, state: 'pending' });
    now += 5_000;
    first.settle(true, 'id 9');
    now += 2_000;
    expect(guard.check(key)).toEqual({
      duplicate: true,
      state: 'done',
      agoMs: 2_000,
      outcome: 'id 9',
    });
  });

  it('forgets a success after the window', () => {
    let now = 0;
    const guard = new DuplicateGuard({ windowMs: 60_000, now: () => now });
    guard.begin(key).settle(true);
    now = 60_001;
    expect(guard.check(key)).toEqual({ duplicate: false });
  });

  it('allows a retry after a failure, which issued nothing', () => {
    const guard = new DuplicateGuard();
    guard.begin(key).settle(false);
    expect(guard.check(key)).toEqual({ duplicate: false });
  });

  it('keeps tenants and arguments apart', () => {
    const guard = new DuplicateGuard();
    guard.begin(key).settle(true);
    expect(
      guard.check(DuplicateGuard.key('other', 'billingo_create_document', { type: 'invoice' })),
    ).toEqual({ duplicate: false });
    expect(
      guard.check(DuplicateGuard.key('t', 'billingo_create_document', { type: 'advance' })),
    ).toEqual({ duplicate: false });
  });

  it('stays bounded', () => {
    const guard = new DuplicateGuard();
    for (let i = 0; i < 10_050; i += 1)
      guard.begin(DuplicateGuard.key('t', 'x', { i })).settle(true);
    guard.check('probe');
    expect(guard.check(DuplicateGuard.key('t', 'x', { i: 0 }))).toEqual({ duplicate: false });
    expect(guard.check(DuplicateGuard.key('t', 'x', { i: 10_049 }))).toMatchObject({
      duplicate: true,
    });
  });
});
