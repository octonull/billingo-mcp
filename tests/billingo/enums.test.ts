// tests/billingo/enums.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BANK_TRANSACTION_PAIRING_STATUSES,
  BANK_TRANSACTION_TYPES,
  CATEGORIES,
  CURRENCIES,
  DOCUMENT_TYPES,
  PAYMENT_METHODS,
  VAT_RATES,
} from '../../src/billingo/enums.js';

interface Spec {
  components: {
    schemas: Record<string, { enum?: string[]; properties?: Record<string, { enum?: string[] }> }>;
  };
}
const spec = JSON.parse(readFileSync('spec/billingo-3.0.15.json', 'utf8')) as Spec;

describe('enums match the vendored spec exactly', () => {
  it.each([
    ['Currency', CURRENCIES],
    ['DocumentType', DOCUMENT_TYPES],
    ['Vat', VAT_RATES],
    ['PaymentMethod', PAYMENT_METHODS],
    ['Category', CATEGORIES],
  ])('%s', (schemaName, ours) => {
    const theirs = spec.components.schemas[schemaName]?.enum;
    expect(theirs).toBeDefined();
    expect([...ours].sort()).toEqual([...(theirs ?? [])].sort());
  });
});

describe('inline property enums match the vendored spec exactly', () => {
  it.each([
    ['BankTransaction', 'type', BANK_TRANSACTION_TYPES],
    ['BankTransaction', 'pairing_status', BANK_TRANSACTION_PAIRING_STATUSES],
  ])('%s.%s', (schemaName, property, ours) => {
    const theirs = spec.components.schemas[schemaName]?.properties?.[property]?.enum;
    expect(theirs).toBeDefined();
    expect([...ours].sort()).toEqual([...(theirs ?? [])].sort());
  });
});
