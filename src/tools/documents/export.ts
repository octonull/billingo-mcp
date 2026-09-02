// src/tools/documents/export.ts
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isoDate } from '../../billingo/dates.js';
import { defineTool, errorResult } from '../registry.js';
import type { AnyToolDefinition } from '../registry.js';

interface ExportStatus {
  id: string;
  state: 'pending' | 'processing' | 'success' | 'warning' | 'fail';
  message?: string;
}

const POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_POLLS = 30; // ~60s; the API documents no SLA, so this is our own bound.

/**
 * Per spec/billingo-3.0.15.json → components.schemas.DocumentExportType.enum. The brief
 * typed this field as a plain `z.string()`, guessing the spec did not enumerate it — it
 * does. There is no plain "csv" value; the closest real member is "simple_csv".
 */
const EXPORT_TYPES = [
  'armada',
  'aws_batch',
  'ex_panda',
  'forintsoft',
  'hessyn',
  'ima',
  'infoteka',
  'kulcs_konyv',
  'maxitax',
  'nagy_machinator',
  'nav_ptgszlah',
  'nav_status',
  'nav_xml',
  'nav_xml_alias',
  'novitax',
  'proforma_outstanding',
  'relax',
  'rlb',
  'rlb60',
  'rlb_double_entry',
  'simple_csv',
  'simple_excel',
  'simple_excel_items',
  'tensoft',
  'tensoft_29_dot_65',
  'used_erase_code',
] as const;
const exportTypeSchema = z.enum(EXPORT_TYPES);

/** Per spec components.schemas.DocumentExportQueryType.enum — which date field start_date/end_date filter by. */
const exportQueryTypeSchema = z.enum(['due_date', 'fulfillment_date', 'invoice_date', 'paid_date']);

/**
 * The export endpoint's Content-Type tells us, correctly, whether the payload is
 * something a model can read directly (CSV, XML, JSON) or an opaque binary file
 * (xlsx). We trust the header rather than sniffing bytes — the API sets it correctly,
 * per the live measurements in the PR description.
 */
function isTextualContentType(contentType: string): boolean {
  const semicolon = contentType.indexOf(';');
  const base = (semicolon === -1 ? contentType : contentType.slice(0, semicolon))
    .trim()
    .toLowerCase();
  if (base.startsWith('text/')) return true;
  if (base === 'application/xml' || base === 'application/json') return true;
  if (base.endsWith('+xml') || base.endsWith('+json')) return true;
  return false;
}

/**
 * The API emits a leading UTF-8 BOM on CSV; strip it so it doesn't corrupt the first
 * column name. `ignoreBOM: true` is deliberate here — the default `TextDecoder` would
 * already strip a BOM for us, which would make the strip below invisible/untestable;
 * decoding with the BOM left in and stripping it ourselves keeps that behavior explicit.
 */
function decodeUtf8StrippingBom(data: Uint8Array): string {
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(data);
  return text.startsWith('﻿') ? text.slice(1) : text;
}

/**
 * Caps how much export text gets inlined into the model's context. 100 KB is generous
 * relative to the measured baseline (a one-month CSV export of a single invoice was
 * 3.4 KB) — it comfortably covers a month of dozens of invoices — while still bounding
 * worst-case context cost for a wide date range. Truncation is always announced, never
 * silent: see the note pushed alongside it below.
 */
const TEXT_INLINE_CAP_BYTES = 100 * 1024;

function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; fullByteLength: number } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes)
    return { text, truncated: false, fullByteLength: encoded.byteLength };
  return {
    text: new TextDecoder('utf-8').decode(encoded.subarray(0, maxBytes)),
    truncated: true,
    fullByteLength: encoded.byteLength,
  };
}

const exportDocuments = defineTool({
  name: 'billingo_export_documents',
  scope: 'read',
  title: 'Export documents',
  description:
    'Exports documents in a date range to a downloadable file, in one of the accounting/reporting formats Billingo supports (e.g. simple_csv, simple_excel, or a named accounting-system format). Creates the export, waits for it to finish, and returns the file. Nothing is modified. ' +
    'Textual formats (simple_csv, nav_xml, and other XML/JSON-based targets) come back as readable text you can analyse directly — very large exports are truncated with an explicit note, and a narrower date range will return the whole thing. Binary formats (simple_excel, simple_excel_items) come back as a file attachment that some MCP clients cannot display inline.',
  inputSchema: {
    // Per spec components.schemas.CreateDocumentExport, the wire field is
    // `document_block_id` and it is NOT required — exposed here under the friendlier
    // name `block_id` and mapped in the handler.
    block_id: z.number().int().optional().describe('Restrict the export to one document block.'),
    start_date: isoDate.describe('Start of the export range.'),
    end_date: isoDate.describe('End of the export range.'),
    query_type: exportQueryTypeSchema
      .optional()
      .describe('Which date field start_date/end_date filter by. Defaults to "invoice_date".'),
    format: exportTypeSchema.describe(
      'Export format/target accounting system. See the enum for valid values.',
    ),
  },
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  handler: async ({ block_id, start_date, end_date, query_type, format }, ctx) => {
    const { client } = ctx;
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxPolls = ctx.maxPolls ?? DEFAULT_MAX_POLLS;

    const created = await client.post<{ id: string }>('/document-export', {
      body: {
        query_type: query_type ?? 'invoice_date',
        start_date,
        end_date,
        export_type: format,
        document_block_id: block_id,
      },
    });

    let status: ExportStatus | undefined;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      status = await client.get<ExportStatus>(`/document-export/${created.id}/poll`);
      if (status.state !== 'pending' && status.state !== 'processing') break;
      await sleep(POLL_INTERVAL_MS);
    }

    if (status === undefined || status.state === 'pending' || status.state === 'processing') {
      return errorResult(
        `The export ${created.id} is still running after ${String(maxPolls)} checks. It was not abandoned — retry billingo_export_documents later, or ask Billingo support about export ${created.id}.`,
      );
    }

    if (status.state === 'fail') {
      return errorResult(`Export ${created.id} failed. ${status.message ?? ''}`.trim());
    }

    const { data, contentType } = await client.getBinary(`/document-export/${created.id}/download`);
    const content: CallToolResult['content'] = [];
    if (status.state === 'warning') {
      content.push({
        type: 'text',
        text: `Export completed with a warning: ${status.message ?? '(no message)'}`,
      });
    }

    if (isTextualContentType(contentType)) {
      const decoded = decodeUtf8StrippingBom(data);
      const { text, truncated, fullByteLength } = truncateUtf8(decoded, TEXT_INLINE_CAP_BYTES);
      if (truncated) {
        content.push({
          type: 'text',
          text: `Truncated: this export is ${String(fullByteLength)} bytes, which exceeds the ${String(TEXT_INLINE_CAP_BYTES)}-byte inline limit. Showing the first ${String(TEXT_INLINE_CAP_BYTES)} bytes below — use a narrower date range to get the whole export in one call.`,
        });
      }
      content.push({ type: 'text', text });
      return { content };
    }

    content.push({
      type: 'text',
      text: `Export ${created.id} (${format}) is a binary ${contentType} file, ${String(data.byteLength)} bytes. It is attached below as a resource; some MCP clients cannot render it inline.`,
    });
    content.push({
      type: 'resource',
      resource: {
        uri: `billingo://document-export/${created.id}`,
        mimeType: contentType,
        blob: Buffer.from(data).toString('base64'),
      },
    });
    return { content };
  },
});

export const documentExportTools: AnyToolDefinition[] = [exportDocuments];
