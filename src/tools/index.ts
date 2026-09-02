// src/tools/index.ts
import { bankAccountTools } from './bank-accounts.js';
import { documentBlockTools } from './document-blocks.js';
import { documentDestructiveTools } from './documents/destructive.js';
import { documentExportTools } from './documents/export.js';
import { documentReadTools } from './documents/read.js';
import { documentWriteTools } from './documents/write.js';
import { organizationTools } from './organization.js';
import { partnerTools } from './partners.js';
import { productTools } from './products.js';
import { spendingTools } from './spendings.js';
import type { AnyToolDefinition } from './registry.js';

/** Every tool the server can offer: 22 read, 27 write. */
export const allTools: AnyToolDefinition[] = [
  ...organizationTools,
  ...partnerTools,
  ...productTools,
  ...spendingTools,
  ...bankAccountTools,
  ...documentBlockTools,
  ...documentReadTools,
  ...documentWriteTools,
  ...documentExportTools,
  ...documentDestructiveTools,
];
