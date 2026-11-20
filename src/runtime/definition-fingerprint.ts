/**
 * What a piece of delegated work was defined by when it started, small enough to store on the activity (a companion: its profile text and bound model) or
 * on the worker (an Automa worker: system prompt, grant and model). A resume or a `continue` compares the stored one with the current one and tells the
 * resumed work when the definition changed. Nothing here blocks a resume; an absent stored fingerprint (older sessions) means nothing is compared.
 */
import {createHash} from 'node:crypto';

export type DefinitionPart = 'prompt' | 'model' | 'grant';
export interface DefinitionParts {readonly prompt?: string | undefined; readonly model?: string | undefined; readonly grant?: string | undefined}
const PARTS: readonly DefinitionPart[] = ['prompt', 'model', 'grant'];

const digest = (...texts: readonly (string | undefined)[]): string => createHash('sha256').update(JSON.stringify(texts)).digest('hex').slice(0, 12);

/** The stored form: the hash of the prompt text, the model name as it was bound, and the hash of the grant. */
export function definitionFingerprint(input: {readonly prompt?: readonly (string | undefined)[]; readonly model?: string | undefined; readonly grant?: readonly string[] | undefined}): string {
  return JSON.stringify({...(input.prompt ? {prompt: digest(...input.prompt)} : {}), ...(input.model !== undefined ? {model: input.model} : {}),
    ...(input.grant ? {grant: digest(...input.grant)} : {})});
}
function parse(text: string | undefined): DefinitionParts | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return value && typeof value === 'object' ? Object.fromEntries(PARTS.flatMap(part => typeof value[part] === 'string' ? [[part, value[part]]] : [])) : undefined;
  } catch {return undefined;}
}
/** The parts that differ between the stored and the current fingerprint; none when nothing was stored, or a part was recorded on only one side. */
export function definitionChanges(stored: string | undefined, current: string): readonly DefinitionPart[] {
  const before = parse(stored), now = parse(current);
  if (!before || !now) return [];
  return PARTS.filter(part => before[part] !== undefined && now[part] !== undefined && before[part] !== now[part]);
}
/** The one line a resumed task is told (and the receipt repeats); undefined when nothing changed. */
export function definitionChangeNote(name: string, changes: readonly DefinitionPart[]): string | undefined {
  return changes.length ? `Note: ${name}'s definition changed since this work started (${changes.join(', ')}); it continues under the current definition.` : undefined;
}
