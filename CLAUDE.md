# CLAUDE.md

Guidance for Claude Code (and any other coding agent) working in this repository.

## What this is

The official Billingo MCP server: an [MCP](https://modelcontextprotocol.io) server exposing
the [Billingo](https://billingo.hu) invoicing API (v3) as tools for LLM agents. It ships two
transports — stdio (for desktop MCP clients) and stateless Streamable HTTP (for
self-hosting) — and 49 tools (22 read, 27 write) covering organizations, partners,
products, spendings, bank accounts, document blocks, and documents (including NAV Online
Számla reporting, exports, and the destructive/write tier).

There was no official Billingo SDK or MCP server before this project — it is the first.

## Commands

```bash
npm run gen:types      # regenerate src/billingo/types.gen.ts from spec/billingo-3.0.15.json
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .
npm test               # vitest run (unit/integration, mocked HTTP via msw)
npm run test:coverage  # vitest run --coverage (kept at 100%)
npm run test:live      # vitest run against the real Billingo sandbox; skips cleanly
                        # without BILLINGO_SANDBOX_API_KEY set
npm run build          # tsc -p tsconfig.build.json
npm run start:stdio    # node dist/transports/stdio.js
npm run start:http     # node dist/transports/http.js
```

Also: `npm run format` / `npm run format:check` (Prettier) and `node scripts/check-spec-drift.mjs`
(compares the vendored specs against upstream SwaggerHub; warns, never fails CI).

## Architecture

Three layers, each ignorant of the one above it:

- **`src/billingo/`** — the HTTP client (`client.ts`), typed errors (`errors.ts`), enums,
  date helpers, pagination helpers, and the generated types (`types.gen.ts`). Knows
  nothing about MCP. It is a plain Billingo API client that could be used standalone.
- **`src/tools/`** — one module per API domain (`organization.ts`, `partners.ts`,
  `products.ts`, `spendings.ts`, `bank-accounts.ts`, `document-blocks.ts`, and
  `documents/{read,write,export,destructive}.ts`), each exporting an array of
  `ToolDefinition`s built with `defineTool` (`registry.ts`). Knows nothing about
  transports — a tool handler only ever sees a `BillingoClient` and returns an MCP
  `CallToolResult`. `src/tools/index.ts` concatenates every domain's tools into `allTools`.
- **`src/transports/`** (`stdio.ts`, `http.ts`) plus `src/server.ts` — only wiring. They
  read config/headers, construct a `BillingoClient`, call `createServer` to build an
  `McpServer` registered with the scoped tool set, and hand it to a transport. No
  business logic lives here.

Why: a contributor adding or changing a tool touches exactly one domain module in
`tools/`. They never need to understand the transports, and the HTTP client never needs
to know a tool call is happening.

## Adding a tool

1. Define it in the relevant domain module with `defineTool({...})`.
2. Pick `scope: 'read'` or `scope: 'write'` honestly — see constraint 3 below ("Write
   tools are filtered out of `tools/list`"). This is a safety decision, not a style one.
3. Add it to that module's exported array (e.g. `partnerTools`).
4. It is automatically picked up by `src/tools/index.ts` into `allTools` — no other wiring
   needed.
5. Update the surface assertions in `tests/server/server.test.ts`: the total-count test
   (`toHaveLength(49)`, `22` read, `27` write) and any per-module test that enumerates
   tool names. These counts are load-bearing — they are the mechanism that catches a
   tool accidentally being left out of an array or given the wrong scope.

## Four non-obvious constraints

1. **TypeScript is pinned to 5.9.3 and not upgradable right now.**
   `openapi-typescript@7.13.0` requires `typescript@^5.x`; `typescript-eslint@8.64.0`
   requires `>=4.8.4 <6.1.0`. TS 6.x/7.x fail `npm install` with `ERESOLVE`. Do not bump
   the `typescript` devDependency without first checking both of those ranges.

   This has already been broken once: Dependabot raised it to 7.0.2, CI went red with
   exactly that `ERESOLVE`, and the PR was merged anyway — leaving `master` impossible to
   install. The pin is now also declared in `.github/dependabot.yml`, because that is
   where the tool that broke it will actually look. The same applies to the Docker build
   stage, which must stay on the Node major that the `distroless/nodejs22` runtime stage
   ships; Dependabot moved the builder to node:26 and left the runtime behind.

2. **The 3.0.14 partner graft.** `GET`, `PUT` and `DELETE /partners/{id}` are live on the
   real API but absent from `spec/billingo-3.0.15.json` — the 3.0.15 document is active
   but unpublished and incomplete. Both `spec/billingo-3.0.14.json` and
   `spec/billingo-3.0.15.json` are vendored; the live API is their union, not either one
   alone. This was proven live (GET → 200, PUT → 200, DELETE → 204). Do not remove the
   by-id partner tools because "the active spec doesn't have them" — see the comments in
   `src/tools/partners.ts` and `scripts/check-spec-drift.mjs`.

3. **Write tools are filtered out of `tools/list`, not rejected at call time.**
   `filterByScope` in `src/tools/registry.ts` removes every `scope: 'write'` tool from
   the registered set when writes are not enabled — the model never learns they exist.
   Read-only is the default in both transports. The 22-read/27-write counts in
   `tests/server/server.test.ts` are the regression guard for this; do not weaken them.

4. **Only GET is ever retried.** `BillingoClient#shouldRetry` in `src/billingo/client.ts`
   retries exclusively on `method === 'GET'`, and only for rate limits (429) and the PDF
   "not ready" status (202 on the download endpoint). POST/PUT/DELETE are never retried,
   even on a network error or 5xx: a retried `POST /documents` would issue a second,
   separately NAV-reported invoice, which cannot be undone.

## Error shapes

The API uses three distinct error body shapes, all handled by `parseErrorBody` in
`src/billingo/errors.ts`:

| Status | Shape                                                                       | Notes                                                                                                                                                                                 |
| ------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4xx    | `{ "error": { "message": string } }`                                        | Generic client error.                                                                                                                                                                 |
| 5xx    | `{ "error": { "message": string, "trace_id": string } }`                    | `trace_id` is folded into the thrown error's message so it survives into whatever the caller (or the model) sees — it is the only handle for Billingo support to look up the failure. |
| 422    | `{ "message": string, "errors": [{ "field": string, "message": string }] }` | Not wrapped in `error` — validation failures use their own shape entirely. Every field issue is folded into the message.                                                              |

Because a **daily write-quota exhaustion also returns HTTP 400**, colliding with the
generic 4xx validation shape, the client does not attempt to classify quota errors
specially — it passes the API's own message straight through rather than guessing.

## API behaviours the spec does not tell you

Each of these was found by calling the real API, and each contradicts what the OpenAPI
document or its prose descriptions imply. They are the reason `npm run test:live` exists:
every one of them passed the mocked suite, because MSW accepts whatever you send it.

- **Every `PUT` is a full replace, not a partial update.** `PUT /partners/{id}` with just
  `{"name":"x"}` returns 422 demanding `address.post_code`, `address.city`,
  `address.address`; products demand `currency`/`unit`/`vat`; bank accounts demand
  `account_number`/`currency`. The `update_*` tools therefore require the same field set
  as their `create_*` counterparts, and their descriptions tell the model to fetch the
  record first and merge. Do not "helpfully" relax those schemas — that just moves the
  422 from us to the API.
- **The finalize endpoints require the full document body.** `PUT /documents/{id}`
  (`CreateDocumentFromDraft`) and `PUT /documents/receipt/{id}` declare
  `requestBody.required: true` with `DocumentInsert` / `ReceiptInsert`. Their prose
  descriptions ("converts a draft to an invoice") read as if no body were needed; sending
  none returns 422 listing every required field.
- **`POST /partners/guess` is an upsert, not a lookup.** It returns a matching partner if
  one exists and otherwise **creates** one. Hence `billingo_guess_partner` is `scope: 'write'`
  despite reading like a search.
- **The API sends no rate-limit headers at all** — not `X-RateLimit-Limit`,
  `-Remaining`, `-Reset`, nor `Retry-After` — even though the spec declares all four on
  every response. The documented limit is 300 req/min authenticated. The client therefore
  cannot pace itself; it reacts to 429 with exponential backoff and honours `Retry-After`
  only if it ever starts appearing.
- **"PDF not ready" is HTTP 202, not an error status.** `GET /documents/{id}/download`
  returns 202 with a `ClientError` body when the PDF has not generated yet. 202 is
  `response.ok`, so without special handling the client would hand the JSON error body
  back as if it were PDF bytes.
- **`GET /organization` is not a company profile.** It returns exactly
  `{tax_code, subscription, has_nav_connection}` — no name, no id, no address.
- **`GET /documents/{id}/online-szamla` errors when there is no NAV record**
  ("NavOnlineSzamla is not found"), e.g. when the organization is not connected to NAV.
  That is not a reporting failure; it means there is nothing to report on.
- **Write schemas are not the read schemas.** Spendings write through `SpendingSave`
  (no `partner_name` — it uses `partner_id`; `paid_at`, not `payment_date`), and
  `DocumentInsert.type` accepts only `[advance, draft, invoice, proforma]`, not the
  17-value `DocumentType`. When in doubt, read `spec/billingo-3.0.15.json` rather than
  trusting a field name that looks obvious.

## Testing conventions

- **Never construct `BillingoClient` at module top level in a test.** It captures
  `globalThis.fetch` in its constructor, so a client built before MSW's `server.listen()`
  silently bypasses MSW and hits the **real Billingo API** — and `onUnhandledRequest: 'error'`
  does not catch it, because the request never enters MSW's pipeline. Build it inside the
  same `beforeAll` that starts the MSW server.
- **Tool tests call `tool.handler(args, ctx)` directly**, which bypasses the zod parse the
  MCP SDK performs in production (`validateToolInput` → `safeParseAsync` → handler). So
  `.default()` on an input schema does not apply in tests, though it does in production.
  Where a default matters, use `.optional()` plus a JS destructuring default.
- **Do not write `as AnyToolDefinition` casts.** `ToolDefinition.handler` is declared with
  method-shorthand syntax, which makes its parameter bivariant, so a concrete
  `ToolDefinition<Shape>` assigns to `AnyToolDefinition` directly. The cast is not merely
  redundant — `@typescript-eslint/no-unnecessary-type-assertion` rejects it and lint fails.
- Hand-copied enums live in `src/billingo/enums.ts` and are pinned to the vendored spec by
  `tests/billingo/enums.test.ts`. That pinning test is the whole reason hand-copying is
  acceptable; if you add an enum, pin it too.
- `npm run test:live` needs `BILLINGO_SANDBOX_API_KEY` and skips cleanly without it, which
  is what fork PRs and fresh clones see. It issues a **real** invoice and stornos it — an
  issued invoice cannot be deleted, so storno is the only legal cleanup, and the suite is
  written so cleanup still runs if an assertion fails.

## Known gaps

- `create_product` requires only `name`, while the spec's `Product.required` is
  `[name, currency, vat, unit]` — the create-side twin of the `PUT`-is-a-full-replace bug.
  It fails loudly with a 422 rather than producing bad data.
- No test exercises the production validation path (see Testing conventions above).
- The npm package name is undecided, so `release.yml` will fail on the placeholder until
  one is chosen.
- CI is advisory unless the `quality`/`test` jobs are made required status checks in the
  branch protection rule — which is how the TypeScript bump got merged over a red build.

## Do not

- Commit secrets. No API key, sandbox or otherwise, belongs in this repository, its
  history, or a test fixture.
- Log an API key. `X-API-KEY` must never appear in a log line, error message, or test
  snapshot.
