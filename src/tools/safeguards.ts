// src/tools/safeguards.ts
/**
 * Extra protection for the write tools whose effect cannot be taken back: an issued
 * invoice is reported to NAV, a storno is itself an invoice, an e-mail cannot be
 * unsent, and a deleted record is gone.
 *
 * Two independent safeguards, both applied by `src/server.ts` around the tool handler,
 * so the tool modules stay unaware of them:
 *
 * - confirm: on clients that can show a form (MCP elicitation), the call pauses and
 *   the user is asked to confirm, with the message built here, before anything is sent
 *   to Billingo. Protocol revision 2026-07-28 does this in-band (a multi-round-trip
 *   request); 2025-era stdio clients get the same form as a server-to-client request.
 *   Returning undefined skips the question (e.g. for a draft, which NAV never sees).
 * - dedupe: an identical call for the same API key, while the first is still running
 *   or within DUPLICATE_WINDOW_MS after it succeeded, is refused unless the caller
 *   passes allow_duplicate: true. Revision 2026-07-28 dropped stream resumability, so
 *   a client whose connection breaks mid-call must send the call again; for
 *   billingo_create_document that would be a second invoice.
 *
 * tests/tools/safeguards.test.ts fails when a write tool that is destructive or not
 * idempotent has no entry here, so a new irreversible tool cannot be added silently.
 * Tools that deliberately need neither are listed with an empty entry.
 */

type Args = Record<string, unknown>;

export interface Safeguard {
  /** The question shown to the user, or undefined to proceed without asking. */
  confirm?: (args: Args) => string | undefined;
  /** Refuse an identical repeat of this call (see the module comment). */
  dedupe?: true;
}

const IRREVERSIBLE = 'This cannot be undone.';
const NAV =
  'It is reported to NAV immediately and cannot be undone (only cancelled with a storno).';

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '?';
}

/** "2 items: Consulting × 3, Hosting × 1": what the user needs to recognise the document. */
function describeItems(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return 'no items';
  const lines = items.slice(0, 5).map((raw: unknown) => {
    const item = (raw ?? {}) as Args;
    const name = item.name !== undefined ? text(item.name) : `product #${text(item.product_id)}`;
    const price =
      item.unit_price === undefined
        ? ''
        : ` at ${text(item.unit_price)} (${text(item.unit_price_type ?? 'net')})`;
    return `${name} × ${text(item.quantity)}${price}`;
  });
  const more = items.length > 5 ? `, and ${String(items.length - 5)} more` : '';
  return `${String(items.length)} item${items.length === 1 ? '' : 's'}: ${lines.join(', ')}${more}`;
}

/** "an invoice", "an advance", "a receipt". */
function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

function issueMessage(verb: string, args: Args): string {
  const partner =
    args.partner_id !== undefined
      ? `partner #${text(args.partner_id)}`
      : text(args.name ?? 'no partner');
  const currency = args.currency === undefined ? '' : `, ${text(args.currency)}`;
  return `${verb} ${withArticle(text(args.type))} for ${partner}${currency}: ${describeItems(args.items)}? ${NAV}`;
}

/** Drafts and proformas are not reported to NAV and can be deleted, so they need no confirmation. */
const reportsToNav = (args: Args): boolean => args.type !== 'draft' && args.type !== 'proforma';

const deleting =
  (what: string) =>
  (args: Args): string =>
    `Delete ${what} #${text(args.id)}? ${IRREVERSIBLE}`;

export const SAFEGUARDS: Readonly<Record<string, Safeguard>> = {
  billingo_create_document: {
    confirm: (args) => (reportsToNav(args) ? issueMessage('Issue', args) : undefined),
    dedupe: true,
  },
  billingo_create_receipt: {
    confirm: (args) => (args.type === 'draft' ? undefined : issueMessage('Issue', args)),
    dedupe: true,
  },
  billingo_finalize_draft: {
    confirm: (args) => issueMessage(`Finalize draft #${text(args.id)} into`, args),
    dedupe: true,
  },
  billingo_finalize_receipt_draft: {
    confirm: (args) => issueMessage(`Finalize draft #${text(args.id)} into`, args),
    dedupe: true,
  },
  billingo_create_document_from_proforma: {
    confirm: (args) => `Issue an invoice from proforma #${text(args.id)}? ${NAV}`,
    dedupe: true,
  },
  billingo_create_modification_document: {
    confirm: (args) =>
      `Issue a modification invoice for document #${text(args.id)}: ${describeItems(args.items)}? ${NAV}`,
    dedupe: true,
  },
  billingo_cancel_document: {
    confirm: (args) =>
      `Cancel document #${text(args.id)} with a storno invoice? The storno is reported to NAV and cannot be undone.`,
    dedupe: true,
  },
  billingo_send_document: {
    confirm: (args) => {
      const emails =
        Array.isArray(args.emails) && args.emails.length > 0
          ? args.emails.map(text).join(', ')
          : "the partner's e-mail addresses";
      return `E-mail document #${text(args.id)} to ${emails}? An e-mail cannot be unsent.`;
    },
    dedupe: true,
  },
  billingo_update_payment: {
    confirm: (args) =>
      `Replace the whole payment history of document #${text(args.id)} with ${String(Array.isArray(args.payments) ? args.payments.length : 0)} payment(s)? Payments not in the new list are removed.`,
  },
  billingo_delete_document: { confirm: deleting('document') },
  billingo_delete_payment: {
    confirm: (args) => `Delete every payment of document #${text(args.id)}? ${IRREVERSIBLE}`,
  },
  billingo_delete_partner: { confirm: deleting('partner') },
  billingo_delete_product: { confirm: deleting('product') },
  billingo_delete_spending: { confirm: deleting('spending') },
  billingo_delete_bank_account: { confirm: deleting('bank account') },

  // Not idempotent or destructive by annotation, but recoverable: the record can be
  // changed back or deleted, and nothing is reported to NAV. Listed so the coverage
  // test sees a decision was made.
  billingo_create_partner: {},
  billingo_update_partner: {},
  billingo_guess_partner: {},
  billingo_create_product: {},
  billingo_update_product: {},
  billingo_create_spending: {},
  billingo_update_spending: {},
  billingo_create_bank_account: {},
  billingo_update_bank_account: {},
  billingo_create_document_block: {},
  billingo_copy_document: {},
};

/** How long a succeeded call blocks an identical repeat. */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 10_000;

/** JSON with sorted object keys, so argument order does not make two calls look different. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Args)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface Entry {
  /** pending: the first call is still running. done: it succeeded at `at`. */
  state: 'pending' | 'done';
  at: number;
  /** e.g. the id of the document the first call created. */
  outcome?: string;
}

export type DuplicateCheck =
  | { duplicate: false }
  | { duplicate: true; state: 'pending' | 'done'; agoMs: number; outcome?: string };

/**
 * Remembers recent non-repeatable calls, per tenant. In-memory: one HTTP server process
 * (or one stdio connection) protects itself; several replicas behind a load balancer do
 * not share it.
 */
export class DuplicateGuard {
  readonly #entries = new Map<string, Entry>();
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(options: { windowMs?: number; now?: () => number } = {}) {
    this.#windowMs = options.windowMs ?? DUPLICATE_WINDOW_MS;
    this.#now = options.now ?? Date.now;
  }

  /** The tenant is a hash of the API key (see tenantId), never the key itself. */
  static key(tenant: string, tool: string, args: Args): string {
    return `${tenant}|${tool}|${stableStringify(args)}`;
  }

  check(key: string): DuplicateCheck {
    this.#prune();
    const entry = this.#entries.get(key);
    if (entry === undefined) return { duplicate: false };
    return {
      duplicate: true,
      state: entry.state,
      agoMs: this.#now() - entry.at,
      ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
    };
  }

  /** Marks the call as running; settle records how it ended. */
  begin(key: string): { settle(succeeded: boolean, outcome?: string): void } {
    this.#entries.set(key, { state: 'pending', at: this.#now() });
    return {
      settle: (succeeded, outcome) => {
        if (!succeeded) {
          // A failed call issued nothing; trying again must be allowed.
          this.#entries.delete(key);
          return;
        }
        this.#entries.set(key, {
          state: 'done',
          at: this.#now(),
          ...(outcome === undefined ? {} : { outcome }),
        });
      },
    };
  }

  #prune(): void {
    const cutoff = this.#now() - this.#windowMs;
    for (const [key, entry] of this.#entries) {
      if (entry.state === 'done' && entry.at < cutoff) this.#entries.delete(key);
    }
    // A stream of distinct calls must not grow memory without bound.
    while (this.#entries.size > MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
