import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssh-mcp-profile-switch-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function extractResponseText(response: any): string {
  if (response.error?.message) return String(response.error.message);
  return String(response.result?.content?.[0]?.text ?? '');
}

async function startServer(configPath: string): Promise<{
  callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;
  close: () => void;
}> {
  const serverPath = path.join(process.cwd(), 'build', 'index.js');
  const child = spawn('node', [serverPath, `--config=${configPath}`, '--timeout=5000'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SSH_MCP_TEST: '1' },
  });

  let idCounter = 1;
  let buffer = '';
  const pending = new Map<number, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        const pendingRequest = pending.get(message.id);
        if (pendingRequest) {
          pending.delete(message.id);
          pendingRequest.resolve(message);
        }
      } catch {
        // ignore non-json output
      }
    }
  });

  const call = (method: string, params: Record<string, unknown>) => {
    const id = idCounter++;
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`RPC timeout for ${method}`));
      }, 15000);
    });
  };

  await call('initialize', {
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
    protocolVersion: '0.1.0',
  });

  return {
    callTool: async (name, args = {}) =>
      call('tools/call', {
        name,
        arguments: args,
      }),
    close: () => {
      if (!child.killed) {
        child.kill();
      }
    },
  };
}

describe('profile switch integration', () => {
  it('switches profile and changes command execution target', async () => {
    const host = '127.0.0.1';
    const user = 'test';
    const password = 'secret';

    const dir = await makeTempDir();
    const configPath = path.join(dir, 'profiles.yaml');
    await writeFile(configPath, `
version: 1
activeProfile: profile-a
profiles:
  - id: profile-a
    name: Profile A
    host: ${host}
    port: 1
    user: ${user}
    auth:
      type: password
      password: "${password}"
    note: "valid target"
    tags: [a]
  - id: profile-b
    name: Profile B
    host: ${host}
    port: 2
    user: ${user}
    auth:
      type: password
      password: "${password}"
    note: "invalid target"
    tags: [b]
`, 'utf8');

    const server = await startServer(configPath);
    try {
      const before = await server.callTool('exec', { command: 'hostname' });
      const beforeText = extractResponseText(before).toLowerCase();
      expect(beforeText).toContain('127.0.0.1:1');

      const switchRes = await server.callTool('profiles-use', { profileId: 'profile-b' });
      expect(extractResponseText(switchRes)).toContain('profile-b');

      const after = await server.callTool('exec', { command: 'hostname' });
      const afterText = extractResponseText(after).toLowerCase();
      expect(afterText).toContain('127.0.0.1:2');
    } finally {
      server.close();
    }
  }, 45000);
});
