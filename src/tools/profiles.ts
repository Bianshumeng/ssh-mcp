import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ProfileManager } from '../profile/profile-manager.js';
import { asTextResult } from './result.js';

export interface ProfileToolDependencies {
  profileManager: ProfileManager;
  onTargetChanged: () => Promise<void>;
}

function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  const message = (err as Error)?.message ?? String(err);
  return new McpError(ErrorCode.InvalidParams, message);
}

export function registerProfileTools(server: McpServer, deps: ProfileToolDependencies): void {
  server.tool(
    'profiles-list',
    'List available SSH profiles with summary metadata.',
    {},
    async () => {
      try {
        return asTextResult({
          configPath: deps.profileManager.getConfigPath(),
          activeProfile: deps.profileManager.getActiveProfileId(),
          profiles: deps.profileManager.listProfiles(),
        });
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-use',
    'Switch active SSH profile for subsequent command execution.',
    {
      profileId: z.string().min(1).describe('Profile id to activate'),
    },
    async ({ profileId }) => {
      try {
        const profile = deps.profileManager.useProfile(profileId);
        await deps.onTargetChanged();
        return asTextResult({
          activeProfile: deps.profileManager.getActiveProfileId(),
          profile,
        });
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-reload',
    'Reload profile configuration from local file and re-validate active profile.',
    {},
    async () => {
      try {
        const result = await deps.profileManager.reload();
        await deps.onTargetChanged();
        return asTextResult(result);
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-note-update',
    'Update note field for a profile and persist it to local config file.',
    {
      profileId: z.string().min(1).describe('Profile id to update'),
      note: z.string().describe('New note text'),
    },
    async ({ profileId, note }) => {
      try {
        const profile = await deps.profileManager.updateNote(profileId, note);
        return asTextResult({
          updatedProfileId: profileId,
          profile,
        });
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );
}

