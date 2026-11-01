import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const FILE = 'onboarding.json';

/** Current onboarding guide revision. Bump when major onboarding steps are introduced. */
export const ONBOARDING_VERSION = 1;

export interface OnboardingPrefs {
  readonly completed: boolean;
  readonly version: number;
  readonly skipped?: boolean;
}

export const ONBOARDING_UNSEEN: OnboardingPrefs = {
  completed: false,
  version: 0,
};

export function parseOnboardingPrefs(text: string): OnboardingPrefs {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return ONBOARDING_UNSEEN;
    }
    const completed = parsed.completed === true;
    const version = typeof parsed.version === 'number' && Number.isFinite(parsed.version) && parsed.version > 0
      ? Math.floor(parsed.version)
      : 0;
    const skipped = parsed.skipped === true;
    return {completed, version, ...(skipped ? {skipped: true} : {})};
  } catch {
    return ONBOARDING_UNSEEN;
  }
}

export function readOnboardingPrefs(homeDir: string = homedir()): OnboardingPrefs {
  try {
    const filePath = join(homeDir, '.logox', FILE);
    if (!existsSync(filePath)) return ONBOARDING_UNSEEN;
    return parseOnboardingPrefs(readFileSync(filePath, 'utf8'));
  } catch {
    return ONBOARDING_UNSEEN;
  }
}

export function markOnboardingDone(version: number = ONBOARDING_VERSION, homeDir: string = homedir()): boolean {
  try {
    const dir = join(homeDir, '.logox');
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const payload: OnboardingPrefs = {
      completed: true,
      version,
    };
    writeFileSync(join(dir, FILE), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function markOnboardingSkipped(version: number = ONBOARDING_VERSION, homeDir: string = homedir()): boolean {
  try {
    const dir = join(homeDir, '.logox');
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const payload: OnboardingPrefs = {
      completed: false,
      version,
      skipped: true,
    };
    writeFileSync(join(dir, FILE), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns whether onboarding should fire on launch.
 * True ONLY when onboarding has never been completed, nor skipped, at the current revision.
 */
export function shouldOfferOnboarding(prefs: OnboardingPrefs = readOnboardingPrefs()): boolean {
  if (prefs.skipped) return false;
  return !prefs.completed || prefs.version < ONBOARDING_VERSION;
}
