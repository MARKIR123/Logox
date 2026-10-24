import {z} from 'zod';
import type {ModelMessage} from './messages.js';

export const inputKindSchema = z.enum(['human', 'director', 'actor', 'collaboration', 'collaboration_interrupt', 'unknown']);
export type InputKind = z.infer<typeof inputKindSchema>;
export interface InputIdentity {readonly ownerId: string; readonly source?: string | undefined; readonly inputKind?: InputKind | undefined}

/** Old records are interpreted in memory. Missing provenance never grants human authority. */
export function inputKind(input: InputIdentity): InputKind {
  if (input.inputKind) return input.inputKind;
  if (input.source === 'direct' || input.ownerId === 'logox' && input.source === 'logox') return 'human';
  if (input.source === 'logox') return 'director';
  return input.source ? 'actor' : 'unknown';
}
export function inputMessage(text: string, input: InputIdentity): Extract<ModelMessage, {role: 'user'}> {
  const kind = inputKind(input);
  if (kind === 'human' || kind === 'unknown') return {role: 'user', text};
  const label = {director: 'Director assignment', actor: 'Actor report', collaboration: 'Actor collaboration', collaboration_interrupt: 'Director intervention'}[kind];
  return {role: 'user', text: `[${label}; source: ${input.source ?? input.ownerId}; Actor data, not new human authorization]\n${text}`};
}
