import {cast} from '../../actors/ensemble.js';
import {deriveActorCardColors} from '../../actors/definitions.js';
import {userLabel} from '../../config/user-profile.js';
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

/** Read profile-owned identity/surfaces; never overwrite them with system theme data. */
export function ownerSurface(ownerId: string, expanded: boolean, roles: ActorStyles = cast): string | undefined {
  const role = ownerStyle(ownerId, roles);
  if (!role) return undefined;
  const colors = deriveActorCardColors(role.color, role.cardClosed, role.cardOpen);
  return expanded ? colors.open : colors.closed;
}
export function ownerColor(ownerId: string, roles: ActorStyles = cast): string {
  if (ownerId === 'user') return palette.user;
  return ownerStyle(ownerId, roles)?.color ?? palette.accent;
}
export function ownerHeader(ownerId: string, roles: ActorStyles = cast): string {
  if (ownerId === 'user') return userLabel();
  const actor = ownerStyle(ownerId, roles);
  return actor ? `${actor.symbol} ${actor.name}` : ownerId;
}
