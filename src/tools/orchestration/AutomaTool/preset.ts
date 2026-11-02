import {z} from 'zod';

const inline = z.string().trim().min(1).max(200).regex(/^[^\r\n\t]+$/);

export const automaPresetSchema = z.strictObject({
  tools: z.enum(['read', 'write']),
  commands: z.array(inline).max(32).optional(),
  /** Commands that produce shared artifacts; they run one at a time across every job in the workspace. */
  exclusive: z.array(inline).max(32).optional(),
  model: inline.optional(),
}).refine(preset => (preset.exclusive ?? []).every(command => preset.commands?.includes(command)), 'exclusive commands must also be listed in commands');

export const automaProfileSchema = z.strictObject({
  name: inline,
  default_preset: inline,
  model: inline.optional(),
  presets: z.record(inline, automaPresetSchema),
}).refine(profile => Object.hasOwn(profile.presets, profile.default_preset), 'default_preset must name an entry in presets');

export type AutomaPreset = z.infer<typeof automaPresetSchema>;
export type AutomaProfile = z.infer<typeof automaProfileSchema>;

export interface AutomaModelChoice {readonly provider: string; readonly model: string}

/**
 * The user's `/model automa` choice always wins. Otherwise `preferred` (preset, then role) applies when this account has it,
 * as an exact name or a family such as `haiku` on the session's provider; otherwise the session model.
 */
export function chooseAutomaModel(input: {
  readonly dedicated: AutomaModelChoice | undefined;
  readonly preferred: string | undefined;
  readonly session: AutomaModelChoice;
  readonly pool: readonly {readonly provider: string; readonly id: string}[];
  /** Expands a shorthand name; may throw when the name is ambiguous. */
  readonly expand: (name: string) => AutomaModelChoice;
}): AutomaModelChoice {
  const {dedicated, preferred, session, pool} = input;
  if (dedicated) return dedicated;
  if (!preferred) return session;
  try {
    const named = input.expand(preferred);
    if (pool.some(item => item.provider === named.provider && item.id === named.model)) return named;
  } catch {}
  const family = pool.filter(item => item.provider === session.provider && item.id.toLowerCase().includes(preferred.toLowerCase())).map(item => item.id).sort().at(-1);
  return family ? {provider: session.provider, model: family} : session;
}

/** Used by actors whose profile has no `automa` block: read-only, with no commands. */
export const DEFAULT_AUTOMA_PROFILE: AutomaProfile = {name: 'automa', default_preset: 'scout', presets: {scout: {tools: 'read'}}};
