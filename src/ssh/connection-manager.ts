import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Client, type ClientChannel } from 'ssh2';
import net from 'net';
import { DEFAULT_TIMEOUT_MS, escapeCommandForShell } from './command-utils.js';

export interface SSHConfig {
  profileId?: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  suPassword?: string;
  sudoPassword?: string;
}

export interface SshTestStepResult {
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface SshTestResult {
  target: string;
  attempts: number;
  tcp: SshTestStepResult;
  handshake: SshTestStepResult;
  auth: SshTestStepResult;
}

export interface SshTestOptions {
  timeoutMs?: number;
  retries?: number;
}

const DEFAULT_CONNECT_RETRY_DELAYS_MS = [200, 400];
const DEFAULT_TEST_TIMEOUT_MS = 10000;
const MAX_TEST_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAuthFailure(err: unknown): boolean {
  const message = toErrorMessage(err).toLowerCase();
  return message.includes('authentication') ||
    message.includes('permission denied') ||
    message.includes('all configured authentication methods failed') ||
    message.includes('auth failed');
}

function isRetryableConnectionError(err: unknown): boolean {
  if (isAuthFailure(err)) return false;
  const message = toErrorMessage(err).toLowerCase();
  const code = (err as { code?: string })?.code;
  if (code && ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code)) {
    return true;
  }
  return message.includes('handshake') ||
    message.includes('kex') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('connection closed') ||
    message.includes('protocol');
}

export function formatTargetContext(config: SSHConfig): string {
  const profileId = config.profileId ? config.profileId : 'unknown';
  return `profileId=${profileId} host=${config.host} port=${config.port}`;
}

export class SSHConnectionManager {
  private conn: Client | null = null;
  private sshConfig: SSHConfig;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;
  private suShell: ClientChannel | null = null;
  private suPromise: Promise<void> | null = null;
  private isElevated = false;

  constructor(config: SSHConfig) {
    this.sshConfig = config;
  }

  async connect(): Promise<void> {
    if (this.conn && this.isConnected()) {
      return;
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    this.isConnecting = true;
    this.connectionPromise = this.connectWithRetry()
      .finally(() => {
        this.isConnecting = false;
        this.connectionPromise = null;
      });

    return this.connectionPromise;
  }

  private async connectWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= DEFAULT_CONNECT_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await this.connectOnce();
        return;
      } catch (err: unknown) {
        lastError = err;
        if (!isRetryableConnectionError(err) || attempt === DEFAULT_CONNECT_RETRY_DELAYS_MS.length) {
          throw this.wrapConnectionError(err);
        }
        await sleep(DEFAULT_CONNECT_RETRY_DELAYS_MS[attempt]);
      }
    }
    throw this.wrapConnectionError(lastError);
  }

  private getConnectConfig(): Omit<SSHConfig, 'profileId'> {
    const { profileId, ...config } = this.sshConfig;
    return config;
  }

  private async connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      this.conn = client;

      const timeoutId = setTimeout(() => {
        client.end();
        if (this.conn === client) {
          this.conn = null;
        }
        const timeoutError = Object.assign(new Error('SSH connection timeout'), { code: 'ETIMEDOUT' });
        reject(timeoutError);
      }, 30000);

      client.on('ready', async () => {
        clearTimeout(timeoutId);

        if (this.sshConfig.suPassword && !process.env.SSH_MCP_TEST) {
          try {
            await this.ensureElevated();
          } catch {
            // Intentionally swallow: non-elevated fallback is still valid.
          }
        }

        resolve();
      });

      client.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        if (this.conn === client) {
          this.conn = null;
        }
        reject(err);
      });

      client.on('end', () => {
        if (this.conn === client) {
          this.conn = null;
        }
      });

      client.on('close', () => {
        if (this.conn === client) {
          this.conn = null;
        }
      });

      client.connect(this.getConnectConfig());
    });
  }

  private wrapConnectionError(err: unknown, targetOverride?: string): McpError {
    const target = targetOverride ?? this.getTargetContext();
    const message = toErrorMessage(err);
    return new McpError(ErrorCode.InternalError, `SSH connection error (${target}): ${message}`);
  }

  isConnected(): boolean {
    return this.conn !== null && Boolean((this.conn as any)._sock) && !(this.conn as any)._sock.destroyed;
  }

  getSudoPassword(): string | undefined {
    return this.sshConfig.sudoPassword;
  }

  setSudoPassword(password?: string): void {
    this.sshConfig.sudoPassword = password;
  }

  getSuPassword(): string | undefined {
    return this.sshConfig.suPassword;
  }

  async setSuPassword(pwd?: string): Promise<void> {
    this.sshConfig.suPassword = pwd;
    if (!pwd) {
      if (this.suShell) {
        try {
          this.suShell.end();
        } catch {
          // no-op
        }
      }
      this.suShell = null;
      this.isElevated = false;
      return;
    }
    try {
      await this.ensureElevated();
    } catch {
      // no-op; command execution can fall back without elevation.
    }
  }

  async ensureElevated(): Promise<void> {
    if (this.isElevated && this.suShell) return;
    if (!this.sshConfig.suPassword) return;
    if (this.suPromise) return this.suPromise;

    const target = this.getTargetContext();
    this.suPromise = new Promise((resolve, reject) => {
      const conn = this.getConnection();
      const timeoutId = setTimeout(() => {
        this.suPromise = null;
        reject(new McpError(ErrorCode.InternalError, `su elevation timed out (${target})`));
      }, 10000);

      conn.shell({ term: 'xterm', cols: 80, rows: 24 }, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          clearTimeout(timeoutId);
          this.suPromise = null;
          reject(new McpError(
            ErrorCode.InternalError,
            `Failed to start interactive shell for su (${target}): ${err.message}`,
          ));
          return;
        }

        let buffer = '';
        let passwordSent = false;

        const cleanup = () => {
          try {
            stream.removeAllListeners('data');
          } catch {
            // no-op
          }
        };

        const onData = (data: Buffer) => {
          const text = data.toString();
          buffer += text;

          if (!passwordSent && /password[: ]/i.test(buffer)) {
            passwordSent = true;
            stream.write(this.sshConfig.suPassword + '\n');
          }

          if (passwordSent && /#/.test(buffer)) {
            clearTimeout(timeoutId);
            cleanup();
            this.suShell = stream;
            this.isElevated = true;
            this.suPromise = null;
            resolve();
            return;
          }

          if (/authentication failure|incorrect password|su: .*failed|su: failure/i.test(buffer)) {
            clearTimeout(timeoutId);
            cleanup();
            this.suPromise = null;
            reject(new McpError(ErrorCode.InternalError, `su authentication failed (${target})`));
          }
        };

        stream.on('data', onData);
        stream.on('close', () => {
          clearTimeout(timeoutId);
          if (!this.isElevated) {
            this.suPromise = null;
            reject(new McpError(ErrorCode.InternalError, `su shell closed before elevation completed (${target})`));
          }
        });

        stream.write('su -\n');
      });
    });

    return this.suPromise;
  }

  async ensureConnected(): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }
  }

  getConnection(): Client {
    if (!this.conn) {
      throw new McpError(ErrorCode.InternalError, `SSH connection not established (${this.getTargetContext()})`);
    }
    return this.conn;
  }

  getTargetContext(): string {
    return formatTargetContext(this.sshConfig);
  }

  getSuShell(): ClientChannel | null {
    return this.suShell;
  }

  close(): void {
    if (!this.conn) return;
    if (this.suShell) {
      try {
        this.suShell.end();
      } catch {
        // no-op
      }
      this.suShell = null;
      this.isElevated = false;
    }
    this.conn.end();
    this.conn = null;
  }
}

export async function execSshCommandWithConnection(
  manager: SSHConnectionManager,
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stdin?: string,
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
}> {
  return new Promise((resolve, reject) => {
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;
    const target = manager.getTargetContext();

    const conn = manager.getConnection();
    const shell = manager.getSuShell();

    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        reject(new McpError(
          ErrorCode.InternalError,
          `Command execution timed out after ${timeoutMs}ms (${target})`,
        ));
      }
    }, timeoutMs);

    if (shell) {
      let buffer = '';
      const dataHandler = (data: Buffer) => {
        const text = data.toString();
        buffer += text;
        if (!/#/.test(buffer)) return;

        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          const lines = buffer.split('\n');
          const output = lines.slice(1, -1).join('\n');
          resolve({
            content: [{
              type: 'text',
              text: output + (output ? '\n' : ''),
            }],
          });
        }
        shell.removeListener('data', dataHandler);
      };

      shell.on('data', dataHandler);
      shell.write(command + '\n');
      return;
    }

    conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
      if (err) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          reject(new McpError(ErrorCode.InternalError, `SSH exec error (${target}): ${err.message}`));
        }
        return;
      }

      let stdout = '';
      let stderr = '';

      if (stdin && stdin.length > 0) {
        try {
          stream.write(stdin);
        } catch {
          // no-op
        }
      }
      try {
        stream.end();
      } catch {
        // no-op
      }

      stream.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      stream.on('close', (code: number) => {
        if (isResolved) return;
        isResolved = true;
        clearTimeout(timeoutId);
        if (stderr) {
          reject(new McpError(ErrorCode.InternalError, `Error (code ${code}) (${target}):\n${stderr}`));
          return;
        }
        resolve({
          content: [{
            type: 'text',
            text: stdout,
          }],
        });
      });
    });
  });
}

export async function execSshCommand(
  sshConfig: SSHConfig,
  command: string,
  stdin?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;
    const target = formatTargetContext(sshConfig);

    timeoutId = setTimeout(() => {
      if (isResolved) return;
      isResolved = true;
      const abortTimeout = setTimeout(() => {
        conn.end();
      }, 5000);

      conn.exec(`timeout 3s pkill -f '${escapeCommandForShell(command)}' 2>/dev/null || true`, (_err, abortStream) => {
        if (abortStream) {
          abortStream.on('close', () => {
            clearTimeout(abortTimeout);
            conn.end();
          });
          return;
        }
        clearTimeout(abortTimeout);
        conn.end();
      });
      reject(new McpError(
        ErrorCode.InternalError,
        `Command execution timed out after ${timeoutMs}ms (${target})`,
      ));
    }, timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            reject(new McpError(ErrorCode.InternalError, `SSH exec error (${target}): ${err.message}`));
          }
          conn.end();
          return;
        }

        if (stdin && stdin.length > 0) {
          try {
            stream.write(stdin);
          } catch {
            // no-op
          }
        }
        try {
          stream.end();
        } catch {
          // no-op
        }

        let stdout = '';
        let stderr = '';
        stream.on('close', (code: number) => {
          if (isResolved) return;
          isResolved = true;
          clearTimeout(timeoutId);
          conn.end();
          if (stderr) {
            reject(new McpError(ErrorCode.InternalError, `Error (code ${code}) (${target}):\n${stderr}`));
            return;
          }
          resolve({
            content: [{
              type: 'text',
              text: stdout,
            }],
          });
        });
        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });

    conn.on('error', (err: Error) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutId);
      reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
    });

    const { profileId, ...connectConfig } = sshConfig;
    conn.connect(connectConfig);
  });
}

function normalizeRetries(retries?: number): number {
  if (retries === undefined || retries === null) return 2;
  if (!Number.isFinite(retries)) return 2;
  const value = Math.max(0, Math.min(MAX_TEST_RETRIES, Math.floor(retries)));
  return value;
}

async function testTcpConnection(host: string, port: number, timeoutMs: number): Promise<SshTestStepResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // no-op
      }
      resolve({
        ok,
        durationMs: Date.now() - start,
        ...(error ? { error } : {}),
      });
    };

    socket.setTimeout(timeoutMs, () => {
      finish(false, 'TCP connection timeout');
    });

    socket.once('error', (err) => {
      finish(false, err.message);
    });

    socket.once('connect', () => {
      finish(true);
    });
  });
}

async function testSshHandshakeAndAuth(
  sshConfig: SSHConfig,
  timeoutMs: number,
): Promise<{ handshake: SshTestStepResult; auth: SshTestStepResult; retryable: boolean }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const client = new Client();
    let settled = false;
    let handshakeOk = false;
    let authOk = false;
    let handshakeDuration = 0;
    let authDuration = 0;
    let errorMessage: string | undefined;
    let retryable = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        // no-op
      }
      resolve({
        handshake: {
          ok: handshakeOk,
          durationMs: handshakeDuration || Date.now() - start,
          ...(handshakeOk ? {} : { error: errorMessage ?? 'Handshake failed' }),
        },
        auth: {
          ok: authOk,
          durationMs: authDuration || Date.now() - start,
          ...(authOk ? {} : { error: errorMessage ?? 'Authentication failed' }),
        },
        retryable,
      });
    };

    const timeoutId = setTimeout(() => {
      errorMessage = 'SSH handshake timeout';
      retryable = true;
      finish();
    }, timeoutMs);

    client.on('banner', () => {
      if (!handshakeOk) {
        handshakeOk = true;
        handshakeDuration = Date.now() - start;
      }
    });

    client.on('ready', () => {
      clearTimeout(timeoutId);
      handshakeOk = true;
      authOk = true;
      if (!handshakeDuration) {
        handshakeDuration = Date.now() - start;
      }
      authDuration = Date.now() - start;
      finish();
    });

    client.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      errorMessage = err.message;
      const authFailure = isAuthFailure(err);
      if (authFailure) {
        handshakeOk = true;
        if (!handshakeDuration) {
          handshakeDuration = Date.now() - start;
        }
      }
      retryable = !authFailure && isRetryableConnectionError(err);
      finish();
    });

    const { profileId, ...connectConfig } = sshConfig;
    client.connect(connectConfig);
  });
}

export async function testSshConnection(
  sshConfig: SSHConfig,
  options: SshTestOptions = {},
): Promise<SshTestResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const retries = normalizeRetries(options.retries);
  const target = formatTargetContext(sshConfig);

  const tcp = await testTcpConnection(sshConfig.host, sshConfig.port, timeoutMs);
  if (!tcp.ok) {
    return {
      target,
      attempts: 0,
      tcp,
      handshake: {
        ok: false,
        durationMs: 0,
        error: 'Skipped due to TCP failure',
      },
      auth: {
        ok: false,
        durationMs: 0,
        error: 'Skipped due to TCP failure',
      },
    };
  }

  let attempts = 0;
  let lastHandshake: SshTestStepResult = { ok: false, durationMs: 0, error: 'Not attempted' };
  let lastAuth: SshTestStepResult = { ok: false, durationMs: 0, error: 'Not attempted' };

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    attempts += 1;
    const result = await testSshHandshakeAndAuth(sshConfig, timeoutMs);
    lastHandshake = result.handshake;
    lastAuth = result.auth;
    if (lastAuth.ok) {
      return {
        target,
        attempts,
        tcp,
        handshake: lastHandshake,
        auth: lastAuth,
      };
    }
    if (!result.retryable || attempt === retries) {
      break;
    }
    const delayMs = Math.min(200 * (2 ** attempt), 2000);
    await sleep(delayMs);
  }

  return {
    target,
    attempts,
    tcp,
    handshake: lastHandshake,
    auth: lastAuth,
  };
}
