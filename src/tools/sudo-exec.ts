import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  execSshCommandWithConnection,
  type SSHConnectionManager,
} from '../ssh/connection-manager.js';
import { sanitizeCommand } from '../ssh/command-utils.js';
import type { RuntimeOptions } from '../cli/args.js';

export interface SudoExecToolDependencies {
  getConnectionManager: () => Promise<SSHConnectionManager>;
  getRuntimeOptions: () => RuntimeOptions;
}

function appendDescription(command: string, description?: string): string {
  if (!description) return command;
  return `${command} # ${description.replace(/#/g, '\\#')}`;
}

export function registerSudoExecTool(server: McpServer, deps: SudoExecToolDependencies): void {
  server.tool(
    'sudo-exec',
    'Execute a shell command on the remote SSH server using sudo. Will use sudo password if provided, otherwise assumes passwordless sudo.',
    {
      command: z.string().describe('Shell command to execute with sudo on the remote SSH server'),
      description: z.string().optional().describe('Optional description of what this command will do'),
      timeoutMs: z.number()
        .int()
        .positive()
        .max(60 * 60 * 1000)
        .optional()
        .describe('Optional per-command timeout override in milliseconds'),
    },
    async ({ command, description, timeoutMs }) => {
      const runtime = deps.getRuntimeOptions();
      const sanitizedCommand = sanitizeCommand(command, runtime.maxChars);
      const effectiveTimeoutMs = timeoutMs ?? runtime.timeoutMs;
      try {
        const manager = await deps.getConnectionManager();
        await manager.ensureConnected();

        const commandWithDescription = appendDescription(sanitizedCommand, description);
        const sudoPassword = manager.getSudoPassword();
        let wrapped: string;

        if (!sudoPassword) {
          wrapped = `sudo -n sh -c '${commandWithDescription.replace(/'/g, "'\\''")}'`;
        } else {
          const escapedPwd = sudoPassword.replace(/'/g, "'\\''");
          wrapped = `printf '%s\\n' '${escapedPwd}' | sudo -p "" -S sh -c '${commandWithDescription.replace(/'/g, "'\\''")}'`;
        }

        return await execSshCommandWithConnection(manager, wrapped, effectiveTimeoutMs);
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCode.InternalError, `Unexpected error: ${(err as Error)?.message ?? err}`);
      }
    },
  );
}
