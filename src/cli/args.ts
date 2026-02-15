import path from 'path';
import { DEFAULT_MAX_CHARS, DEFAULT_TIMEOUT_MS, parseMaxChars } from '../ssh/command-utils.js';
import { type ProfileDefaults } from '../config/types.js';

export interface LegacyCliConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  key?: string;
  suPassword?: string;
  sudoPassword?: string;
}

export interface RuntimeOptions {
  timeoutMs: number;
  maxChars: number;
  disableSudo: boolean;
}

export type StartupMode =
  | {
    mode: 'legacy';
    legacy: LegacyCliConfig;
    runtime: RuntimeOptions;
  }
  | {
    mode: 'profile';
    configPath: string;
    profileIdOverride?: string;
    runtime: RuntimeOptions;
  };

export type ArgvConfig = Record<string, string | null | undefined>;

export function parseArgv(argv = process.argv.slice(2)): ArgvConfig {
  const config: ArgvConfig = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const equalIndex = arg.indexOf('=');
    if (equalIndex === -1) {
      config[arg.slice(2)] = null;
      continue;
    }
    config[arg.slice(2, equalIndex)] = arg.slice(equalIndex + 1);
  }
  return config;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parsePositiveInt(input: string | null | undefined, fallback: number): number {
  if (typeof input !== 'string' || input.trim() === '') return fallback;
  const parsed = Number.parseInt(input, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function hasLegacyTargetArgs(config: ArgvConfig): boolean {
  return [
    'host',
    'user',
    'port',
    'password',
    'key',
    'suPassword',
    'sudoPassword',
  ].some((key) => config[key] !== undefined);
}

export function validateConfig(config: ArgvConfig): void {
  const errors: string[] = [];
  if (!config.host) errors.push('Missing required --host');
  if (!config.user) errors.push('Missing required --user');
  if (config.port && Number.isNaN(Number(config.port))) errors.push('Invalid --port');
  if (errors.length > 0) {
    throw new Error(`Configuration error:\n${errors.join('\n')}`);
  }
}

export function resolveRuntimeOptions(config: ArgvConfig, defaults?: ProfileDefaults): RuntimeOptions {
  const timeoutMs = parsePositiveInt(
    config.timeout as string | undefined,
    defaults?.timeout ?? DEFAULT_TIMEOUT_MS,
  );

  const maxCharsSource = config.maxChars ?? defaults?.maxChars;
  const maxChars = parseMaxChars(maxCharsSource, DEFAULT_MAX_CHARS);

  const disableSudo = config.disableSudo !== undefined
    ? true
    : Boolean(defaults?.disableSudo ?? false);

  return {
    timeoutMs,
    maxChars,
    disableSudo,
  };
}

export function determineStartupMode(config: ArgvConfig): StartupMode {
  const configPathRaw = normalizeOptionalString(config.config as string | null | undefined);
  const hasConfigMode = typeof configPathRaw === 'string' && configPathRaw.trim() !== '';
  const hasLegacyArgs = hasLegacyTargetArgs(config);

  if (hasConfigMode && hasLegacyArgs) {
    throw new Error('Configuration error:\nCannot combine --config with legacy target args (--host/--user/--password/--key/...)');
  }

  if (!hasConfigMode && normalizeOptionalString(config.profile as string | null | undefined)) {
    throw new Error('Configuration error:\n--profile can only be used together with --config');
  }

  if (hasConfigMode) {
    return {
      mode: 'profile',
      configPath: path.resolve(configPathRaw as string),
      profileIdOverride: normalizeOptionalString(config.profile as string | null | undefined),
      runtime: resolveRuntimeOptions(config),
    };
  }

  validateConfig(config);
  return {
    mode: 'legacy',
    legacy: {
      host: config.host as string,
      port: parsePositiveInt(config.port as string | undefined, 22),
      user: config.user as string,
      password: normalizeOptionalString(config.password as string | null | undefined),
      key: normalizeOptionalString(config.key as string | null | undefined),
      suPassword: normalizeOptionalString(config.suPassword as string | null | undefined),
      sudoPassword: normalizeOptionalString(config.sudoPassword as string | null | undefined),
    },
    runtime: resolveRuntimeOptions(config),
  };
}
