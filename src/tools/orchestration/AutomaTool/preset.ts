import {z} from 'zod';

const inline = z.string().trim().min(1).max(200).regex(/^[^\r\n\t]+$/);

/** A worker style: the system-prompt flavour, model and concurrency of a kind of worker. It grants nothing. */
export const automaStyleSchema = z.strictObject({
  model: inline.optional(),
  /** How many workers of this style run at once; the dispatch can still ask for fewer. */
  parallel: z.number().int().min(1).max(8).optional(),
  /** A short paragraph appended to the worker's system prompt. */
  flavor: z.string().trim().min(1).max(800).optional(),
});

/** Accepts the retired `default_preset` / `presets` shape: grants (`tools`, `commands`) are dropped, `exclusive` moves to the profile. */
function migrateLegacyProfile(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = {...(value as Record<string, unknown>)};
  if (raw.presets === undefined || raw.styles !== undefined) return raw;
  const exclusive = new Set<string>(Array.isArray(raw.exclusive) ? raw.exclusive.filter((item): item is string => typeof item === 'string') : []);
  const styles: Record<string, unknown> = {};
  for (const [name, preset] of Object.entries(raw.presets as Record<string, unknown>)) {
    const item = preset && typeof preset === 'object' ? preset as Record<string, unknown> : {};
    if (Array.isArray(item.exclusive)) for (const command of item.exclusive) if (typeof command === 'string') exclusive.add(command);
    styles[name] = {...(item.model !== undefined ? {model: item.model} : {}), ...(item.flavor !== undefined ? {flavor: item.flavor} : {})};
  }
  const {presets: _presets, default_preset, ...rest} = raw;
  return {...rest, ...(default_preset !== undefined ? {default_style: default_preset} : {}), styles, ...(exclusive.size ? {exclusive: [...exclusive]} : {})};
}

export const automaProfileSchema = z.preprocess(migrateLegacyProfile, z.strictObject({
  name: inline,
  /** The style the runtime uses unless a dispatch names another. */
  default_style: inline,
  /** The style used when a job edits the workspace (`writes`); falls back to `default_style`. */
  write_style: inline.optional(),
  model: inline.optional(),
  /** Command prefixes that run one at a time across a dispatch's workers (shared build artifacts). */
  exclusive: z.array(inline).max(32).optional(),
  styles: z.record(inline, automaStyleSchema),
}).refine(profile => Object.hasOwn(profile.styles, profile.default_style) && (!profile.write_style || Object.hasOwn(profile.styles, profile.write_style)),
  'default_style and write_style must name entries in styles'));

export type AutomaStyle = z.infer<typeof automaStyleSchema>;
export type AutomaProfile = z.output<typeof automaProfileSchema>;

/** The runtime picks the style; a valid name from the model wins, an unknown one is ignored with a note. */
export function chooseStyle(profile: AutomaProfile, requested: string | undefined, writes: boolean): {name: string; note?: string} {
  if (requested && Object.hasOwn(profile.styles, requested)) return {name: requested};
  const name = writes && profile.write_style ? profile.write_style : profile.default_style;
  return requested ? {name, note: `Style "${requested}" does not exist (available: ${Object.keys(profile.styles).join(', ')}); used "${name}". You never need to name one.`} : {name};
}

export interface AutomaModelChoice {readonly provider: string; readonly model: string}

/**
 * The user's `/model automa` choice always wins. Otherwise `preferred` (style, then role) applies when this account has it,
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

/** Used by actors whose profile has no `automa` block: one plain style. */
export const DEFAULT_AUTOMA_PROFILE: AutomaProfile = {name: 'automa', default_style: 'scout', styles: {scout: {}}};
