import {
  loadProfilesConfig,
  profileSummary,
  saveRawProfilesConfig,
} from '../config/loader.js';
import { type LoadedProfilesConfig, type ProfileDefinition } from '../config/types.js';

function hasProfile(profiles: ProfileDefinition[], profileId: string): boolean {
  return profiles.some((profile) => profile.id === profileId);
}

export class ProfileManager {
  private loadedConfig: LoadedProfilesConfig | null = null;
  private activeProfileId: string | null = null;
  private readonly profileOverride?: string;
  private readonly configPath: string;

  constructor(configPath: string, profileOverride?: string) {
    this.configPath = configPath;
    this.profileOverride = profileOverride;
  }

  async initialize(): Promise<void> {
    const loaded = await loadProfilesConfig(this.configPath);
    this.loadedConfig = loaded;
    this.activeProfileId = this.pickActiveProfileId(loaded, this.profileOverride);
  }

  private ensureLoaded(): LoadedProfilesConfig {
    if (!this.loadedConfig || !this.activeProfileId) {
      throw new Error('ProfileManager is not initialized');
    }
    return this.loadedConfig;
  }

  private pickActiveProfileId(loaded: LoadedProfilesConfig, preferred?: string): string {
    const candidates = [preferred, this.profileOverride, loaded.config.activeProfile];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (hasProfile(loaded.config.profiles, candidate)) {
        return candidate;
      }
    }
    throw new Error('Unable to resolve an active profile from configuration');
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getActiveProfileId(): string {
    this.ensureLoaded();
    return this.activeProfileId as string;
  }

  getActiveProfile(): ProfileDefinition {
    const loaded = this.ensureLoaded();
    const activeId = this.activeProfileId as string;
    const profile = loaded.config.profiles.find((item) => item.id === activeId);
    if (!profile) {
      throw new Error(`Active profile "${activeId}" not found`);
    }
    return profile;
  }

  getDefaults(): LoadedProfilesConfig['config']['defaults'] {
    const loaded = this.ensureLoaded();
    return loaded.config.defaults ?? {};
  }

  listProfiles(): Record<string, unknown>[] {
    const loaded = this.ensureLoaded();
    const activeId = this.activeProfileId as string;
    return loaded.config.profiles.map((profile) => profileSummary(profile, activeId));
  }

  useProfile(profileId: string): Record<string, unknown> {
    const loaded = this.ensureLoaded();
    const profile = loaded.config.profiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new Error(`Profile "${profileId}" does not exist`);
    }
    this.activeProfileId = profileId;
    return profileSummary(profile, profileId);
  }

  async reload(): Promise<Record<string, unknown>> {
    const previousActiveId = this.activeProfileId ?? undefined;
    const loaded = await loadProfilesConfig(this.configPath);
    this.loadedConfig = loaded;
    this.activeProfileId = this.pickActiveProfileId(loaded, previousActiveId);

    return {
      configPath: this.configPath,
      activeProfile: this.activeProfileId,
      profileCount: loaded.config.profiles.length,
      profiles: this.listProfiles(),
    };
  }

  async updateNote(profileId: string, note: string): Promise<Record<string, unknown>> {
    const loaded = this.ensureLoaded();
    const profile = loaded.config.profiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new Error(`Profile "${profileId}" does not exist`);
    }

    profile.note = note;
    const rawProfiles = loaded.rawConfig.profiles;
    if (!Array.isArray(rawProfiles)) {
      throw new Error('Invalid raw config: profiles is not an array');
    }

    const rawProfile = rawProfiles.find((item) =>
      Boolean(item)
      && typeof item === 'object'
      && !Array.isArray(item)
      && (item as Record<string, unknown>).id === profileId,
    ) as Record<string, unknown> | undefined;

    if (!rawProfile) {
      throw new Error(`Raw config profile "${profileId}" not found`);
    }

    rawProfile.note = note;
    await saveRawProfilesConfig(loaded);
    await this.reload();

    return profileSummary(this.getProfile(profileId), this.getActiveProfileId());
  }

  private getProfile(profileId: string): ProfileDefinition {
    const loaded = this.ensureLoaded();
    const profile = loaded.config.profiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new Error(`Profile "${profileId}" does not exist`);
    }
    return profile;
  }
}
