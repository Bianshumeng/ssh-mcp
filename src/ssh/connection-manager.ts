import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Client, type ClientChannel } from 'ssh2';
import { DEFAULT_TIMEOUT_MS, escapeCommandForShell } from './command-utils.js';

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  suPassword?: string;
  sudoPassword?: string;
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
    this.connectionPromise = new Promise((resolve, reject) => {
      this.conn = new Client();

      const timeoutId = setTimeout(() => {
        this.conn?.end();
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        reject(new McpError(ErrorCode.InternalError, 'SSH connection timeout'));
      }, 30000);

      this.conn.on('ready', async () => {
        clearTimeout(timeoutId);
        this.isConnecting = false;
        this.connectionPromise = null;

        if (this.sshConfig.suPassword && !process.env.SSH_MCP_TEST) {
          try {
            await this.ensureElevated();
          } catch {
            // Intentionally swallow: non-elevated fallback is still valid.
          }
        }

        resolve();
      });

      this.conn.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
      });

      this.conn.on('end', () => {
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
      });

      this.conn.on('close', () => {
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
      });

      this.conn.connect(this.sshConfig);
    });

    return this.connectionPromise;
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

    this.suPromise = new Promise((resolve, reject) => {
      const conn = this.getConnection();
      const timeoutId = setTimeout(() => {
        this.suPromise = null;
        reject(new McpError(ErrorCode.InternalError, 'su elevation timed out'));
      }, 10000);

      conn.shell({ term: 'xterm', cols: 80, rows: 24 }, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          clearTimeout(timeoutId);
          this.suPromise = null;
          reject(new McpError(ErrorCode.InternalError, `Failed to start interactive shell for su: ${err.message}`));
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
            reject(new McpError(ErrorCode.InternalError, 'su authentication failed'));
          }
        };

        stream.on('data', onData);
        stream.on('close', () => {
          clearTimeout(timeoutId);
          if (!this.isElevated) {
            this.suPromise = null;
            reject(new McpError(ErrorCode.InternalError, 'su shell closed before elevation completed'));
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
      throw new McpError(ErrorCode.InternalError, 'SSH connection not established');
    }
    return this.conn;
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

    const conn = manager.getConnection();
    const shell = manager.getSuShell();

    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        reject(new McpError(ErrorCode.InternalError, `Command execution timed out after ${timeoutMs}ms`));
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
          reject(new McpError(ErrorCode.InternalError, `SSH exec error: ${err.message}`));
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
          reject(new McpError(ErrorCode.InternalError, `Error (code ${code}):\n${stderr}`));
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
      reject(new McpError(ErrorCode.InternalError, `Command execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            reject(new McpError(ErrorCode.InternalError, `SSH exec error: ${err.message}`));
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
            reject(new McpError(ErrorCode.InternalError, `Error (code ${code}):\n${stderr}`));
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

    conn.connect(sshConfig);
  });
}

