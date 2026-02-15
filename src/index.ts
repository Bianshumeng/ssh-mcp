#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  determineStartupMode,
  parseArgv,
  resolveRuntimeOptions,
  type ArgvConfig,
  type RuntimeOptions,
  type StartupMode,
} from './cli/args.js';
import { ProfileManager } from './profile/profile-manager.js';
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_TIMEOUT_MS,
  sanitizeCommand,
} from './ssh/command-utils.js';
import {
  SSHConnectionManager,
  type SSHConfig,
  execSshCommand,
  execSshCommandWithConnection,
} from './ssh/connection-manager.js';
import { buildSshConfigFromProfile } from './ssh/ssh-config.js';
import { registerExecTool } from './tools/exec.js';
import { registerProfileTools } from './tools/profiles.js';
import { registerSudoExecTool } from './tools/sudo-exec.js';

const isTestMode = process.env.SSH_MCP_TEST === '1';
const isCliEnabled = process.env.SSH_MCP_DISABLE_MAIN !== '1';
const shouldBootServer = isCliEnabled || isTestMode;
const argvConfig: ArgvConfig = shouldBootServer ? parseArgv() : {};

const server = new McpServer({
  name: 'SSH MCP Server',
  version: '2.0.0',
  capabilities: {
    resources: {},
    tools: {},
  },
});

let startupMode: StartupMode | null = null;
let profileManager: ProfileManager | null = null;
let connectionManager: SSHConnectionManager | null = null;
let initialRuntimeOptions: RuntimeOptions = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxChars: DEFAULT_MAX_CHARS,
  disableSudo: false,
};

function getRuntimeOptions(): RuntimeOptions {
  if (profileManager) {
    return resolveRuntimeOptions(argvConfig, profileManager.getDefaults());
  }
  return initialRuntimeOptions;
}

async function closeConnectionManager(): Promise<void> {
  if (!connectionManager) return;
  connectionManager.close();
  connectionManager = null;
}

async function buildSshConfig(mode: StartupMode): Promise<SSHConfig> {
  if (!profileManager) {
    throw new McpError(ErrorCode.InternalError, 'Profile mode not initialized');
  }

  const profile = profileManager.getActiveProfile();
  return buildSshConfigFromProfile(profile, profileManager.getConfigPath());
}

async function getConnectionManager(): Promise<SSHConnectionManager> {
  if (!startupMode) {
    throw new McpError(ErrorCode.InternalError, 'Server startup mode is not initialized');
  }
  if (connectionManager) {
    return connectionManager;
  }

  const sshConfig = await buildSshConfig(startupMode);
  connectionManager = new SSHConnectionManager(sshConfig);
  return connectionManager;
}

async function initializeRuntime(): Promise<void> {
  startupMode = determineStartupMode(argvConfig);
  profileManager = new ProfileManager(startupMode.configPath, startupMode.profileIdOverride);
  await profileManager.initialize();
  initialRuntimeOptions = resolveRuntimeOptions(argvConfig, profileManager.getDefaults());
}

function registerTools(): void {
  registerExecTool(server, {
    getConnectionManager,
    getRuntimeOptions,
  });

  if (!getRuntimeOptions().disableSudo) {
    registerSudoExecTool(server, {
      getConnectionManager,
      getRuntimeOptions,
    });
  }

  if (profileManager) {
    registerProfileTools(server, {
      profileManager,
      onTargetChanged: closeConnectionManager,
    });
  }
}

async function bootstrapServer(): Promise<void> {
  await initializeRuntime();
  registerTools();
}

async function runMain(): Promise<void> {
  await bootstrapServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('SSH MCP Server running on stdio');

  const cleanup = () => {
    closeConnectionManager()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => {
    if (connectionManager) {
      connectionManager.close();
    }
  });
}

if (isTestMode) {
  bootstrapServer()
    .then(async () => {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    })
    .catch((error) => {
      console.error('Fatal error connecting server:', error);
      process.exit(1);
    });
} else if (isCliEnabled) {
  runMain().catch((error) => {
    console.error('Fatal error in main():', error);
    closeConnectionManager().finally(() => process.exit(1));
  });
}

export {
  parseArgv,
  sanitizeCommand,
  SSHConnectionManager,
  execSshCommandWithConnection,
  execSshCommand,
};
