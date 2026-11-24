import {cast} from '../../actors/ensemble.js';
import {deriveActorCardColors} from '../../actors/definitions.js';
import {contrastRatio, relativeLuminance, TEXT_CONTRAST} from '../../config/theme-legibility.js';
import {userLabel} from '../../config/user-profile.js';
import {mixHex} from './colors.js';
import {palette} from './theme.js';

export interface ActivityVerbs {
  readonly search?: readonly string[] | undefined;
  readonly read?: readonly string[] | undefined;
  readonly list?: readonly string[] | undefined;
  readonly browse?: readonly string[] | undefined;
  readonly run?: readonly string[] | undefined;
}
export interface ActorStyle {
  readonly symbol: string;
  readonly name: string;
  readonly title: string;
  readonly color: string;
  readonly cardClosed?: string | undefined;
  readonly cardOpen?: string | undefined;
  readonly thinkingAnimation?: readonly string[] | undefined;
  /** Optional `Gerund/Past` verb pools per tool-group category (see `activity_verbs` in the actor profile). */
  readonly activityVerbs?: ActivityVerbs | undefined;
}
export type ActorStyles = Readonly<Record<string, ActorStyle>>;

/** Anamnesis is an actor like any other whose identity colour is the theme's `anamnesis` token (read live). */
export function anamnesisStyle(): ActorStyle {
  return {symbol: '◇', name: 'Anamnesis', title: 'Anamnesis', color: palette.anamnesis};
}
/** The style of an owner: its profile, or the Anamnesis identity. */
export function ownerStyle(ownerId: string, roles: ActorStyles = cast): ActorStyle | undefined {
  return roles[ownerId] ?? (ownerId === 'anamnesis' ? anamnesisStyle() : undefined);
}

const isLightCanvas = (): boolean => relativeLuminance(palette.bg) > 0.5;
const LIGHT_COLOR_MIX_STEPS: readonly number[] = [0.85, 0.72, 0.60, 0.48, 0.36];

/** Read profile-owned identity/surfaces; never overwrite them with system theme data. */
export function ownerSurface(ownerId: string, expanded: boolean, roles: ActorStyles = cast): string | undefined {
  const role = ownerStyle(ownerId, roles);
  if (!role) return undefined;
  const colors = deriveActorCardColors(role.color, role.cardClosed, role.cardOpen);
  const surface = expanded ? colors.open : colors.closed;
  if (isLightCanvas() && relativeLuminance(surface) < 0.5) {
    return mixHex(role.color, palette.bg, expanded ? 0.14 : 0.08);
  }
  return surface;
}
export function ownerColor(ownerId: string, roles: ActorStyles = cast): string {
  const raw = ownerId === 'user' ? palette.user : ownerStyle(ownerId, roles)?.color ?? palette.accent;
  if (!isLightCanvas() || contrastRatio(raw, palette.bg) >= TEXT_CONTRAST) return raw;
  for (const share of LIGHT_COLOR_MIX_STEPS) {
    const candidate = mixHex(raw, palette.strong, share);
    if (contrastRatio(candidate, palette.bg) >= TEXT_CONTRAST) return candidate;
  }
  return mixHex(raw, palette.strong, 0.35);
}
export function ownerHeader(ownerId: string, roles: ActorStyles = cast): string {
  if (ownerId === 'user') return userLabel();
  const actor = ownerStyle(ownerId, roles);
  return actor ? `${actor.symbol} ${actor.name}` : ownerId;
}
