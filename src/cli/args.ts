import path from 'path';
import { DEFAULT_MAX_CHARS, DEFAULT_TIMEOUT_MS, parseMaxChars } from '../ssh/command-utils.js';
import { type ProfileDefaults } from '../config/types.js';

export interface RuntimeOptions {
  timeoutMs: number;
  maxChars: number;
  disableSudo: boolean;
}

export interface StartupMode {
  mode: 'profile';
  configPath: string;
  profileIdOverride?: string;
  runtime: RuntimeOptions;
}

export type ArgvConfig = Record<string, string | null | undefined>;

const LEGACY_ARG_KEYS = [
  'host',
  'user',
  'port',
  'password',
  'key',
  'suPassword',
  'sudoPassword',
] as const;

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
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInt(input: string | null | undefined, fallback: number): number {
  if (typeof input !== 'string' || input.trim() === '') return fallback;
  const parsed = Number.parseInt(input, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function hasLegacyTargetArgs(config: ArgvConfig): boolean {
  return LEGACY_ARG_KEYS.some((key) => config[key] !== undefined);
}

export function validateConfig(config: ArgvConfig): void {
  const configPath = normalizeOptionalString(config.config as string | null | undefined);
  if (!configPath) {
    throw new Error('Configuration error:\nMissing required --config=<path>. Legacy --host/--user startup is no longer supported.');
  }

  if (hasLegacyTargetArgs(config)) {
    throw new Error(
      'Configuration error:\nLegacy target args (--host/--user/--password/--key/...) are no longer supported. Use --config and manage targets via profiles tools.',
    );
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
  validateConfig(config);

  const configPath = normalizeOptionalString(config.config as string | null | undefined) as string;
  const profileIdOverride = normalizeOptionalString(config.profile as string | null | undefined);

  return {
    mode: 'profile',
    configPath: path.resolve(configPath),
    profileIdOverride,
    runtime: resolveRuntimeOptions(config),
  };
}

