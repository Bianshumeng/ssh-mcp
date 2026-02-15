import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { ProfileManager } from '../src/profile/profile-manager';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssh-mcp-profile-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ProfileManager', () => {
  it('switches active profile and persists note updates', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: a
profiles:
  - id: a
    name: Alpha
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "secret-a"
    note: "note-a"
    tags: [a]
  - id: b
    name: Beta
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "secret-b"
    note: "note-b"
    tags: [b]
`, 'utf8');

    const manager = new ProfileManager(filePath);
    await manager.initialize();

    const listedBefore = manager.listProfiles();
    expect((listedBefore[0] as any).auth.password).toBe('***');
    expect(manager.getActiveProfileId()).toBe('a');

    manager.useProfile('b');
    expect(manager.getActiveProfileId()).toBe('b');

    await manager.updateNote('b', 'updated-note');
    const listedAfter = manager.listProfiles();
    const updated = listedAfter.find((item) => (item as any).id === 'b') as any;
    expect(updated.note).toBe('updated-note');

    const reloaded = new ProfileManager(filePath);
    await reloaded.initialize();
    const persisted = reloaded.listProfiles().find((item) => (item as any).id === 'b') as any;
    expect(persisted.note).toBe('updated-note');
  });
});

