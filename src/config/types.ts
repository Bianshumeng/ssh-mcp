import { z } from 'zod';

const intFromStringSchema = z.string().regex(/^-?\d+$/).transform((value) => Number.parseInt(value, 10));

const intLikeSchema = z.union([
  z.number().int(),
  intFromStringSchema,
]).transform((value) => value as number);

const positiveIntLikeSchema = intLikeSchema.refine(
  (value) => value > 0,
  { message: 'must be a positive integer' },
);

const booleanLikeSchema = z.union([z.boolean(), z.string()]).transform((value, ctx) => {
  if (typeof value === 'boolean') return value;
  const lowered = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
  if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'must be a boolean-like value',
  });
  return z.NEVER;
});

export const maxCharsConfigSchema = z.union([
  z.literal('none'),
  intLikeSchema,
]);

const passwordAuthSchema = z.object({
  type: z.literal('password'),
  password: z.string().min(1, 'password auth requires a non-empty password'),
}).strict();

const keyAuthSchema = z.object({
  type: z.literal('key'),
  keyPath: z.string().min(1, 'key auth requires a non-empty keyPath'),
}).strict();

export const profileAuthSchema = z.discriminatedUnion('type', [
  passwordAuthSchema,
  keyAuthSchema,
]);

export const profileDefaultsSchema = z.object({
  timeout: positiveIntLikeSchema.optional(),
  maxChars: maxCharsConfigSchema.optional(),
  disableSudo: booleanLikeSchema.optional(),
}).default({});

const portSchema = positiveIntLikeSchema.refine((value) => value <= 65535, {
  message: 'port must be between 1 and 65535',
});

export const profileSchema = z.object({
  id: z.string().min(1, 'profile id is required'),
  name: z.string().min(1, 'profile name is required'),
  host: z.string().min(1, 'profile host is required'),
  port: portSchema.default(22),
  user: z.string().min(1, 'profile user is required'),
  auth: profileAuthSchema,
  suPassword: z.string().min(1).optional(),
  sudoPassword: z.string().min(1).optional(),
  note: z.string().default(''),
  tags: z.array(z.string()).default([]),
}).strict();

export const profilesConfigSchema = z.object({
  version: z.literal(1),
  activeProfile: z.string().min(1, 'activeProfile is required'),
  defaults: profileDefaultsSchema.optional().default({}),
  profiles: z.array(profileSchema).min(1, 'at least one profile is required'),
}).strict().superRefine((value, ctx) => {
  const seenIds = new Set<string>();
  for (const profile of value.profiles) {
    if (seenIds.has(profile.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate profile id: ${profile.id}`,
        path: ['profiles'],
      });
    }
    seenIds.add(profile.id);
  }
});

export type ProfileAuth = z.infer<typeof profileAuthSchema>;
export type ProfileDefaults = z.infer<typeof profileDefaultsSchema>;
export type ProfileDefinition = z.infer<typeof profileSchema>;
export type ProfilesConfig = z.infer<typeof profilesConfigSchema>;

export interface LoadedProfilesConfig {
  filePath: string;
  format: 'yaml' | 'json';
  config: ProfilesConfig;
  rawConfig: Record<string, unknown>;
}

