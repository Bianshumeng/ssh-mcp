import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, access, stat } from 'fs/promises';
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

    await manager.setActiveProfile('b', true);
    expect(manager.getActiveProfileId()).toBe('b');

    await manager.updateNote('b', 'updated-note');
    const listedAfter = manager.listProfiles();
    const updated = listedAfter.find((item) => (item as any).id === 'b') as any;
    expect(updated.note).toBe('updated-note');

    const reloaded = new ProfileManager(filePath);
    await reloaded.initialize();
    const persisted = reloaded.listProfiles().find((item) => (item as any).id === 'b') as any;
    expect(persisted.note).toBe('updated-note');
    expect(reloaded.getActiveProfileId()).toBe('b');
  });

  it('creates, finds, prepares delete with backup, and confirms delete with explicit confirmation text', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: alpha
profiles:
  - id: alpha
    name: Alpha
    host: alpha.example.com
    user: root
    auth:
      type: password
      password: "secret-alpha"
    note: "alpha note"
    tags: [prod]
  - id: beta
    name: Beta
    host: beta.example.com
    user: root
    auth:
      type: password
      password: "secret-beta"
    note: "beta note"
    tags: [staging]
`, 'utf8');

    const manager = new ProfileManager(filePath);
    await manager.initialize();

    const created = await manager.createProfile({
      id: 'gamma',
      name: 'Gamma Relay',
      host: 'gamma.example.com',
      user: 'root',
      auth: { type: 'password', password: 'secret-gamma' },
      contextSummary: '用户说这是跳板机',
      tags: ['relay', 'jp'],
      activate: true,
    });
    expect((created as any).id).toBe('gamma');
    expect(manager.getActiveProfileId()).toBe('gamma');

    const matched = manager.findProfiles('relay');
    expect(matched.length).toBeGreaterThan(0);
    expect((matched[0] as any).id).toBe('gamma');

    const prepared = await manager.prepareDeleteProfile('gamma');
    const deleteRequestId = (prepared as any).deleteRequestId as string;
    const backupPath = (prepared as any).backupPath as string;
    expect(deleteRequestId).toBeTruthy();
    expect(backupPath).toContain('.ssh-mcp-backups');
    await access(backupPath);

    await expect(
      manager.confirmDeleteProfile(deleteRequestId, 'gamma', 'DELETE alpha'),
    ).rejects.toThrow('Invalid confirmationText');

    const confirmed = await manager.confirmDeleteProfile(
      deleteRequestId,
      'gamma',
      'DELETE gamma',
    );
    expect((confirmed as any).deletedProfileId).toBe('gamma');

    const updatedConfig = await readFile(filePath, 'utf8');
    expect(updatedConfig).not.toContain('id: gamma');
    expect(updatedConfig).toContain('activeProfile:');
  });

  it('does not persist profile when create validation fails', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: alpha
profiles:
  - id: alpha
    name: Alpha
    host: alpha.example.com
    user: root
    auth:
      type: password
      password: "secret-alpha"
`, 'utf8');

    const manager = new ProfileManager(filePath);
    await manager.initialize();

    await expect(manager.createProfile({
      id: 'broken-key-profile',
      name: 'Broken Key',
      host: 'broken.example.com',
      user: 'root',
      auth: { type: 'key', keyPath: './keys/not-exists' },
      activate: true,
    })).rejects.toThrow('keyPath does not exist');

    const persistedConfig = await readFile(filePath, 'utf8');
    expect(persistedConfig).not.toContain('broken-key-profile');
    expect(persistedConfig).toContain('activeProfile: alpha');
  });

  it('sanitizes backup path reason and keeps backups under backup directory', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: alpha
profiles:
  - id: alpha
    name: Alpha
    host: alpha.example.com
    user: root
    auth:
      type: password
      password: "secret-alpha"
  - id: ../danger/path
    name: Danger
    host: danger.example.com
    user: root
    auth:
      type: password
      password: "secret-danger"
`, 'utf8');

    const manager = new ProfileManager(filePath);
    await manager.initialize();

    const prepared = await manager.prepareDeleteProfile('../danger/path');
    const backupPath = (prepared as any).backupPath as string;
    const backupDir = path.resolve(path.dirname(filePath), '.ssh-mcp-backups');
    const normalizedBackupPath = path.resolve(backupPath).toLowerCase();
    const normalizedBackupDir = backupDir.toLowerCase();
    expect(normalizedBackupPath.startsWith(normalizedBackupDir + path.sep.toLowerCase())).toBe(true);
    expect(normalizedBackupPath).not.toContain('..');
    await access(backupPath);
    if (process.platform !== 'win32') {
      const backupStat = await stat(backupPath);
      expect(backupStat.mode & 0o777).toBe(0o600);
    }
  });

  it('deleting unrelated profile does not rewrite persisted active profile from startup override', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: alpha
profiles:
  - id: alpha
    name: Alpha
    host: alpha.example.com
    user: root
    auth:
      type: password
      password: "secret-alpha"
  - id: beta
    name: Beta
    host: beta.example.com
    user: root
    auth:
      type: password
      password: "secret-beta"
  - id: gamma
    name: Gamma
    host: gamma.example.com
    user: root
    auth:
      type: password
      password: "secret-gamma"
`, 'utf8');

    const manager = new ProfileManager(filePath, 'beta');
    await manager.initialize();
    expect(manager.getActiveProfileId()).toBe('beta');

    const prepared = await manager.prepareDeleteProfile('gamma');
    const requestId = (prepared as any).deleteRequestId as string;
    await manager.confirmDeleteProfile(requestId, 'gamma', 'DELETE gamma');

    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).toContain('activeProfile: alpha');
    expect(persisted).not.toContain('id: gamma');
    expect(manager.getActiveProfileId()).toBe('beta');
  });
});
