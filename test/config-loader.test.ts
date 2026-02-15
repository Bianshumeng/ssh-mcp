import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadProfilesConfig } from '../src/config/loader';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssh-mcp-config-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('config loader', () => {
  it('expands env vars and validates active profile', async () => {
    process.env.SSH_MCP_TEST_PASSWORD = 'secret';
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: a
defaults:
  timeout: 120000
profiles:
  - id: a
    name: A
    host: 127.0.0.1
    port: 22
    user: root
    auth:
      type: password
      password: "\${SSH_MCP_TEST_PASSWORD}"
    note: "test"
`, 'utf8');

    const loaded = await loadProfilesConfig(filePath);
    expect(loaded.config.activeProfile).toBe('a');
    expect(loaded.config.profiles[0].auth.type).toBe('password');
    expect((loaded.config.profiles[0].auth as any).password).toBe('secret');
  });

  it('throws when env var is missing', async () => {
    delete process.env.SSH_MCP_MISSING_PASSWORD;
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: a
profiles:
  - id: a
    name: A
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "\${SSH_MCP_MISSING_PASSWORD}"
`, 'utf8');

    await expect(loadProfilesConfig(filePath)).rejects.toThrow('Missing required environment variable: SSH_MCP_MISSING_PASSWORD');
  });

  it('throws when active profile does not exist', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: missing
profiles:
  - id: a
    name: A
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "secret"
`, 'utf8');

    await expect(loadProfilesConfig(filePath)).rejects.toThrow('activeProfile "missing" does not exist in profiles');
  });
});

