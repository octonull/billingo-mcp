#!/usr/bin/env node
// src/bin/stdio.ts — the package's `bin`; see run.ts for why this file exists.
import { main } from '../transports/stdio.js';
import { run } from './run.js';

run(main);
