import { readFile } from 'fs/promises';
import { resolveKeyPath } from '../config/loader.js';
import type { ProfileDefinition } from '../config/types.js';
import { sanitizePassword } from './command-utils.js';
import type { SSHConfig } from './connection-manager.js';

export async function buildSshConfigFromProfile(
  profile: ProfileDefinition,
  configPath: string,
): Promise<SSHConfig> {
  const sshConfig: SSHConfig = {
    profileId: profile.id,
    host: profile.host,
    port: profile.port,
    username: profile.user,
  };

  try {
    if (profile.auth.type === 'password') {
      sshConfig.password = sanitizePassword(profile.auth.password);
    } else {
      const keyPath = resolveKeyPath(profile.auth.keyPath, configPath);
      sshConfig.privateKey = await readFile(keyPath, 'utf8');
    }

    if (profile.suPassword !== undefined) {
      sshConfig.suPassword = sanitizePassword(profile.suPassword);
    }
    if (profile.sudoPassword !== undefined) {
      sshConfig.sudoPassword = sanitizePassword(profile.sudoPassword);
    }
  } catch (err: unknown) {
    const message = (err as Error)?.message ?? String(err);
    throw new Error(
      `Failed to load SSH credentials for profile "${profile.id}" (${profile.host}:${profile.port}): ${message}`,
    );
  }

  return sshConfig;
}
