import { describe, expect, it } from 'vitest';
import { determineStartupMode } from '../src/cli/args';

describe('startup mode resolution', () => {
  it('uses profile mode when config is provided', () => {
    const startup = determineStartupMode({
      config: './config/ssh-mcp.profiles.yaml',
      profile: 'alpha',
    });
    expect(startup.mode).toBe('profile');
    expect(startup.profileIdOverride).toBe('alpha');
  });

  it('throws when config is missing', () => {
    expect(() =>
      determineStartupMode({
        profile: 'alpha',
      }),
    ).toThrow('Missing required --config');
  });

  it('throws when legacy args are provided', () => {
    expect(() =>
      determineStartupMode({
        config: './profiles.yaml',
        host: '127.0.0.1',
        user: 'root',
      }),
    ).toThrow('Legacy target args');
  });
});

