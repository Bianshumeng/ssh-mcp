import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';

const testServerPath = join(process.cwd(), 'build', 'index.js');
const testConfigPath = join(process.cwd(), 'test', 'fixtures', 'profiles.local.yaml');
const START_TIMEOUT = 10000;

beforeAll(() => {
  process.env.SSH_MCP_TEST = '1';
});

function runProfilesTest(profileId = 'no-pass'): Promise<any> {
  const args = [
    testServerPath,
    `--config=${testConfigPath}`,
    `--profile=${profileId}`,
    '--timeout=60000',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('node', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SSH_MCP_TEST: '1' } });
    let buffer = '';
    const startup = setTimeout(() => {
      child.kill();
      reject(new Error('Server start timeout'));
    }, START_TIMEOUT);

    const toolCall = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'profiles-test', arguments: { profileId, timeoutMs: 5000, retries: 0 } },
    };

    const initMsg = {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { capabilities: {}, clientInfo: { name: 't', version: '1' }, protocolVersion: '0.1.0' },
    };

    child.stdout.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 0) {
            child.stdin.write(JSON.stringify(toolCall) + '\n');
          } else if (msg.id === 1) {
            clearTimeout(startup);
            resolve(msg);
            child.kill();
            return;
          }
        } catch {
          // ignore non-json
        }
      }
    });

    child.stderr.on('data', () => { /* ignore */ });
    child.on('error', (err) => { clearTimeout(startup); reject(err); });

    setTimeout(() => {
      child.stdin.write(JSON.stringify(initMsg) + '\n');
    }, 100);
  });
}

describe('profiles-test tool', () => {
  it('returns structured tcp/handshake/auth results', async () => {
    const res = await runProfilesTest();
    expect(res.error).toBeUndefined();
    const payload = JSON.parse(res.result?.content?.[0]?.text ?? '{}');
    expect(payload.profileId).toBe('no-pass');
    expect(payload.result?.tcp?.ok).not.toBeUndefined();
    expect(payload.result?.handshake?.ok).not.toBeUndefined();
    expect(payload.result?.auth?.ok).not.toBeUndefined();
  });
});
