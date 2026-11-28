// tests/mcpb/manifest.test.ts
// The Claude Desktop Extension manifest (mcpb/manifest.json) is plain JSON that the
// compiler never sees, so these tests pin it to the code it configures: the env vars
// it sets must be the ones loadStdioConfig reads, and the settings it offers must
// produce the configuration they describe.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadStdioConfig } from '../../src/config.js';
import { TOOL_CATEGORIES } from '../../src/tools/index.js';

interface UserConfigField {
  type: string;
  required?: boolean;
  sensitive?: boolean;
  default?: string | boolean;
  description: string;
}

interface Manifest {
  version: string;
  server: {
    entry_point: string;
    mcp_config: { command: string; args: string[]; env: Record<string, string> };
  };
  user_config: Record<string, UserConfigField>;
}

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const manifest = readJson('../../mcpb/manifest.json') as Manifest;
const pkg = readJson('../../package.json') as { bin: Record<string, string> };
const { env } = manifest.server.mcp_config;

const field = (name: string): UserConfigField => {
  const f = manifest.user_config[name];
  if (f === undefined) throw new Error(`user_config.${name} is missing`);
  return f;
};

/** Mimics Claude Desktop: replaces each ${user_config.x} with the user's value as text. */
function resolveEnv(values: Record<string, string | boolean>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, template]) => [
      key,
      template.replace(/\$\{user_config\.(\w+)\}/g, (_, name: string) => {
        const value = values[name] ?? field(name).default;
        if (value === undefined) throw new Error(`no value for user_config.${name}`);
        return String(value);
      }),
    ]),
  );
}

describe('mcpb manifest', () => {
  it('sets exactly the env vars the stdio transport reads', () => {
    expect(Object.keys(env).sort()).toEqual([
      'BILLINGO_ALLOW_WRITE',
      'BILLINGO_API_KEY',
      'BILLINGO_CONFIRM_WRITES',
      'BILLINGO_TOOL_CATEGORIES',
    ]);
  });

  it('only references user_config fields that exist', () => {
    const referenced = Object.values(env).flatMap((t) =>
      [...t.matchAll(/\$\{user_config\.(\w+)\}/g)].map((m) => m[1]),
    );
    expect(referenced.sort()).toEqual(Object.keys(manifest.user_config).sort());
  });

  it('starts the same entry point as the npm bin', () => {
    const bin = pkg.bin['billingo-mcp']?.replace(/^\.\//, '');
    expect(manifest.server.entry_point).toBe(`server/${String(bin)}`);
    expect(manifest.server.mcp_config.args).toEqual([
      `\${__dirname}/${manifest.server.entry_point}`,
    ]);
  });

  it('asks for the API key as a required secret', () => {
    expect(field('api_key')).toMatchObject({ type: 'string', required: true, sensitive: true });
  });

  it('is read-only with every tool category when only the key is given', () => {
    expect(field('allow_write').default).toBe(false);
    expect(loadStdioConfig(resolveEnv({ api_key: 'k' }))).toMatchObject({
      apiKey: 'k',
      allowWrite: false,
      categories: undefined,
    });
  });

  it('turns writes on and narrows the categories when asked to', () => {
    expect(
      loadStdioConfig(
        resolveEnv({ api_key: 'k', allow_write: true, tool_categories: 'documents, partners' }),
      ),
    ).toMatchObject({ allowWrite: true, categories: ['documents', 'partners'] });
  });

  it('lists every tool category in the categories setting', () => {
    const listed = field('tool_categories').description.split(':').pop() ?? '';
    expect(
      listed
        .replace(/\.$/, '')
        .split(',')
        .map((c) => c.trim()),
    ).toEqual(TOOL_CATEGORIES);
  });

  // pack-mcpb.mjs stamps the package.json version at pack time; a real version here
  // would go stale at the next release PR, which bumps package.json only.
  it('leaves the version to the pack script', () => {
    expect(manifest.version).toBe('0.0.0');
  });
});
