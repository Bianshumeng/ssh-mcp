import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ProfileManager, type ProfileCreateInput } from '../profile/profile-manager.js';
import { buildSshConfigFromProfile } from '../ssh/ssh-config.js';
import { testSshConnection } from '../ssh/connection-manager.js';
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
    'List available SSH profiles with summary metadata. Use this first to identify target profile by id/host/note/tags.',
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
    'Switch active SSH profile for subsequent command execution. The selected profile is persisted as activeProfile in config.',
    {
      profileId: z.string().min(1).describe('Profile id to activate'),
    },
    async ({ profileId }) => {
      try {
        const profile = await deps.profileManager.setActiveProfile(profileId, true);
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
    'Update note field for a profile and persist it to local config file. Keep note short and precise so future matching stays accurate.',
    {
      profileId: z.string().min(1).describe('Profile id to update'),
      note: z.string().describe('New concise note text (recommended <= 120 chars)'),
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

  server.tool(
    'profiles-find',
    'Find profile candidates by keyword across id/name/host/user/note/tags. Use this to precisely locate the correct SSH target before switching or deleting.',
    {
      query: z.string().describe('Search keyword, such as host fragment, role tag, or note keyword'),
    },
    async ({ query }) => {
      try {
        return asTextResult({
          query,
          activeProfile: deps.profileManager.getActiveProfileId(),
          matches: deps.profileManager.findProfiles(query),
        });
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-test',
    'Test TCP connectivity, SSH handshake, and authentication for a profile without executing commands.',
    {
      profileId: z.string().min(1).optional().describe('Optional profile id; defaults to current active profile'),
      timeoutMs: z.number()
        .int()
        .positive()
        .max(60 * 1000)
        .optional()
        .describe('Optional timeout per attempt in milliseconds (default 10000)'),
      retries: z.number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe('Retry count for handshake/network failures (default 2)'),
    },
    async ({ profileId, timeoutMs, retries }) => {
      try {
        const profile = profileId
          ? deps.profileManager.getProfileById(profileId)
          : deps.profileManager.getActiveProfile();
        const sshConfig = await buildSshConfigFromProfile(profile, deps.profileManager.getConfigPath());
        const result = await testSshConnection(sshConfig, { timeoutMs, retries });
        return asTextResult({
          profileId: profile.id,
          result,
        });
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-create',
    'Create a new SSH profile template at runtime. Note is optional but recommended; if omitted, a short note is generated from context.',
    {
      id: z.string().min(1).describe('Unique profile id (stable key)'),
      name: z.string().min(1).describe('Human-readable profile name'),
      host: z.string().min(1).describe('SSH host or IP'),
      port: z.number().int().min(1).max(65535).optional().describe('SSH port, default 22'),
      user: z.string().min(1).describe('SSH username'),
      authType: z.enum(['password', 'key']).describe('Authentication method'),
      password: z.string().optional().describe('Required when authType=password; plain value or ${ENV_VAR}'),
      keyPath: z.string().optional().describe('Required when authType=key; absolute or config-relative path'),
      suPassword: z.string().optional().describe('Optional su password'),
      sudoPassword: z.string().optional().describe('Optional sudo password'),
      note: z.string().optional().describe('Optional concise note; recommended to describe role/purpose'),
      contextSummary: z.string().optional().describe('Optional context used to auto-generate note when note is omitted'),
      tags: z.array(z.string()).optional().describe('Optional tags for later matching'),
      activate: z.boolean().optional().describe('Whether to activate this profile immediately, default true'),
    },
    async (input) => {
      try {
        let auth: ProfileCreateInput['auth'];
        if (input.authType === 'password') {
          if (!input.password || input.password.trim().length === 0) {
            throw new Error('password is required when authType=password');
          }
          auth = { type: 'password', password: input.password };
        } else {
          if (!input.keyPath || input.keyPath.trim().length === 0) {
            throw new Error('keyPath is required when authType=key');
          }
          auth = { type: 'key', keyPath: input.keyPath };
        }

        const profile = await deps.profileManager.createProfile({
          id: input.id,
          name: input.name,
          host: input.host,
          port: input.port,
          user: input.user,
          auth,
          suPassword: input.suPassword,
          sudoPassword: input.sudoPassword,
          note: input.note,
          contextSummary: input.contextSummary,
          tags: input.tags,
          activate: input.activate,
        });

        if (input.activate ?? true) {
          await deps.onTargetChanged();
        }

        return asTextResult({
          createdProfileId: input.id,
          activeProfile: deps.profileManager.getActiveProfileId(),
          profile,
        });
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-delete-prepare',
    'Prepare deletion for a profile. This step creates a backup and returns a deleteRequestId + confirmationText. Always show result to the user and ask explicit confirmation before calling profiles-delete-confirm.',
    {
      profileId: z.string().min(1).describe('Exact profile id to delete'),
    },
    async ({ profileId }) => {
      try {
        const result = await deps.profileManager.prepareDeleteProfile(profileId);
        return asTextResult(result);
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-delete-confirm',
    'Execute profile deletion after explicit user confirmation. Requires deleteRequestId and exact confirmationText from profiles-delete-prepare response.',
    {
      deleteRequestId: z.string().min(1).describe('Delete request id returned by profiles-delete-prepare'),
      profileId: z.string().min(1).describe('Exact profile id to delete'),
      confirmationText: z.string().min(1).describe('Must exactly match the confirmationText returned by prepare step'),
    },
    async ({ deleteRequestId, profileId, confirmationText }) => {
      try {
        const result = await deps.profileManager.confirmDeleteProfile(
          deleteRequestId,
          profileId,
          confirmationText,
        );
        await deps.onTargetChanged();
        return asTextResult(result);
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );
}
