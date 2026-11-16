import {z} from 'zod';
import type {ThinkingEffort} from '../../../config/model-preferences.js';
import {likelyToolCapable} from '../../../providers/model-marks.js';

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

/** A worker model; `effort` is the dedicated binding's own thinking effort (absent means the session's). */
export interface AutomaModelChoice {readonly provider: string; readonly model: string; readonly effort?: ThinkingEffort | undefined}

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
  /** The route's automatic default (`autoAutomaModel()`), used instead of the session model when nothing else names a model. */
  readonly auto?: (() => AutomaModelChoice) | undefined;
}): AutomaModelChoice {
  const {dedicated, preferred, session, pool} = input;
  if (dedicated) return dedicated;
  const fallback = () => input.auto?.() ?? session;
  if (!preferred) return fallback();
  try {
    const named = input.expand(preferred);
    if (pool.some(item => item.provider === named.provider && item.id === named.model)) return named;
  } catch {}
  const family = pool.filter(item => item.provider === session.provider && item.id.toLowerCase().includes(preferred.toLowerCase())).map(item => item.id).sort().at(-1);
  return family ? {provider: session.provider, model: family} : fallback();
}

/** Which model a job runs on: the read model (no `writes` grant), the code model (a `writes` grant), or the vision fallback. */
export type AutomaRoute = 'read' | 'code' | 'vision';

/**
 * The automatic worker model of a route when its `/model automa` key is unbound, decided by tier marks and catalog prices, never by guessed difficulty:
 * the read route wants the cheapest T1 model of the session's provider that is likely tool-capable, the code route the cheapest T2.
 * A provider without that tier gets the nearest lower tier, then the nearest higher one, never above the session model's own tier;
 * when nothing qualifies the session model is used. A model without a catalog price sorts after every priced one.
 */
export function autoAutomaModel(input: {
  readonly route: 'read' | 'code';
  readonly session: AutomaModelChoice;
  readonly pool: readonly {readonly provider: string; readonly id: string}[];
  readonly tier: (provider: string, model: string) => number;
  readonly price: (provider: string, model: string) => number | undefined;
}): AutomaModelChoice {
  const {session} = input;
  if (!session.model) return session;
  const target = input.route === 'read' ? 1 : 2, ceiling = input.tier(session.provider, session.model);
  const candidates = [...new Set(input.pool.filter(item => item.provider === session.provider && likelyToolCapable(item.id)).map(item => item.id))]
    .map(id => ({id, tier: input.tier(session.provider, id), price: input.price(session.provider, id) ?? Infinity}));
  const cheapest = (tier: number) => candidates.filter(item => item.tier === tier).sort((a, b) => a.price - b.price || a.id.localeCompare(b.id))[0];
  const order = [target, ...Array.from({length: target - 1}, (_, index) => target - 1 - index), ...Array.from({length: Math.max(0, ceiling - target)}, (_, index) => target + 1 + index)];
  for (const tier of order) {
    const found = cheapest(tier);
    if (found) return {provider: session.provider, model: found.id};
  }
  return session;
}

/** Used by actors whose profile has no `automa` block: one plain style. */
export const DEFAULT_AUTOMA_PROFILE: AutomaProfile = {name: 'automa', default_style: 'scout', styles: {scout: {}}};
