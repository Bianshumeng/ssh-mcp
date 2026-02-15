import { describe, expect, it } from 'vitest';
import { determineStartupMode } from '../src/cli/args';

describe('startup mode resolution', () => {
  it('keeps legacy mode when host/user are provided', () => {
    const startup = determineStartupMode({
      host: '127.0.0.1',
      user: 'root',
      password: 'secret',
    });
    expect(startup.mode).toBe('legacy');
  });

  it('uses profile mode when config is provided', () => {
    const startup = determineStartupMode({
      config: './config/ssh-mcp.profiles.yaml',
      profile: 'alpha',
    });
    expect(startup.mode).toBe('profile');
    if (startup.mode === 'profile') {
      expect(startup.profileIdOverride).toBe('alpha');
    }
  });

  it('throws on conflicting config and legacy args', () => {
    expect(() =>
      determineStartupMode({
        config: './profiles.yaml',
        host: '127.0.0.1',
        user: 'root',
      }),
    ).toThrow('Cannot combine --config with legacy target args');
  });

  it('throws when --profile is used without --config', () => {
    expect(() =>
      determineStartupMode({
        profile: 'alpha',
        host: '127.0.0.1',
        user: 'root',
      }),
    ).toThrow('--profile can only be used together with --config');
  });
});

