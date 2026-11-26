#!/usr/bin/env node
// Builds the Claude Desktop Extension: build/mcpb/billingo-mcp-<version>.mcpb.
//
// Run through `npm run pack:mcpb`, which builds dist/ first. The bundle carries the
// compiled server with its production dependencies only, so Claude Desktop runs it with
// its own Node and the user installs nothing.
//
// mcpb/manifest.json keeps "version": "0.0.0" on purpose: the release PR bumps only
// package.json, so the version is taken from there at pack time and never drifts.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build', 'mcpb');
const stage = join(out, 'stage');
const mcpb = join(root, 'node_modules', '.bin', 'mcpb');

// npm and the .bin shims are .cmd files on Windows, which only start through a shell.
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

if (!existsSync(join(root, 'dist', 'bin', 'stdio.js'))) {
  console.error(
    'dist/bin/stdio.js is missing: run `npm run build` first (or use `npm run pack:mcpb`).',
  );
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'mcpb', 'manifest.json'), 'utf8'));
manifest.version = version;

rmSync(out, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });

// server.ts reads ../package.json at startup for the version it reports, so the
// package.json has to sit next to dist/ inside the bundle too.
for (const file of ['dist', 'package.json', 'package-lock.json', 'LICENSE']) {
  cpSync(join(root, file), join(stage, 'server', file), { recursive: true });
}
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// The lockfile pins the runtime dependencies to exactly what the npm package resolves.
run(
  'npm',
  ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  join(stage, 'server'),
);

const target = join(out, `billingo-mcp-${version}.mcpb`);
run(mcpb, ['validate', join(stage, 'manifest.json')], root);
run(mcpb, ['pack', stage, target], root);
console.log(`\n${target}`);
