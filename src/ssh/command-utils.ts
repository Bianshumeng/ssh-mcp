import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_MAX_CHARS = 1000;
export const DEFAULT_TIMEOUT_MS = 60000;

export function parseMaxChars(value: unknown, fallback = DEFAULT_MAX_CHARS): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fallback;
    if (value <= 0) return Infinity;
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'none') return Infinity;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isNaN(parsed)) return fallback;
    if (parsed <= 0) return Infinity;
    return parsed;
  }
  return fallback;
}

export function sanitizeCommand(command: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (typeof command !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Command must be a string');
  }

  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    throw new McpError(ErrorCode.InvalidParams, 'Command cannot be empty');
  }

  if (Number.isFinite(maxChars) && trimmedCommand.length > (maxChars as number)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Command is too long (max ${maxChars} characters)`,
    );
  }

  return trimmedCommand;
}

export function sanitizePassword(password: string | undefined): string | undefined {
  if (typeof password !== 'string') return undefined;
  if (password.length === 0) return undefined;
  return password;
}

export function escapeCommandForShell(command: string): string {
  return command.replace(/'/g, "'\"'\"'");
}

