#!/usr/bin/env node
// src/bin/http.ts — the HTTP entry point (Docker CMD, `npm run start:http`); see run.ts.
import { main } from '../transports/http.js';
import { run } from './run.js';

run(main);
