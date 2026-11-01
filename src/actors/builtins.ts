import {readFileSync} from 'node:fs';
import {immutable} from '../runtime/contracts.js';
import {parseActorProfile, type ActorDefinition} from './definitions.js';

/** Personas and summary contracts are taken verbatim from profiles/<id>/; each role is self-contained with no shared sections appended. */
const profile = (id: string, name: string) => new TextDecoder('utf-8', {fatal: true})
  .decode(readFileSync(new URL('./profiles/' + id + '/' + name, import.meta.url))).trim();
function optionalProfile(id: string, name: string): string | undefined {
  try {return profile(id, name) || undefined;}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
}
function role(id: string, name: string, title: string, symbol: string, description: string, tools: number, skills: string[] = []): ActorDefinition {
  const execution = optionalProfile(id, 'execution.md'), collaboration = optionalProfile(id, 'collaboration.md');
  const prompt = profile(id, 'persona.md'), compression = profile(id, 'compression.md');
  // Only visual defaults come from YAML here; preserve the builtin behavior/context contract.
  // Installed user profiles still take precedence when ActorCatalog loads them.
  const {color, cardClosed, cardOpen} = parseActorProfile({config: profile(id, 'config.yaml'), persona: prompt, compression,
    ...(execution ? {execution} : {}), ...(collaboration ? {collaboration} : {})});
  return immutable({id, name, title, symbol, color, description, prompt, compression,
    ...(execution ? {execution} : {}), ...(collaboration ? {collaboration} : {}),
    ...(cardClosed ? {cardClosed} : {}),
    ...(cardOpen ? {cardOpen} : {}),
    context: {keep_recent_rounds: id === 'logox' ? 2 : 0, keep_recent_tools: tools}, skills});
}
export const builtinActors: readonly ActorDefinition[] = immutable([
  role('logox', 'Logox', 'Director', '◈', 'Talks with the user, breaks down goals, orchestrates the ensemble, merges results, and handles simple tasks directly.', 2),
  role('aletheia', 'Aletheia', 'Scout', '◎', 'Investigates code, logs, and sources; traces call chains, verifies origins, and delivers a verifiable fact map.', 2,
    ['investigate-first', 'diagnosing-bugs', 'research']),
  role('techne', 'Techne', 'Builder', '⊞', 'Reasons, builds modules, fixes root causes, and closes implementations with real verification.', 2,
    ['tdd', 'safe-refactor', 'surgical-patch', 'codebase-design', 'lean-build']),
  role('kalon', 'Kalon', 'Aesthete', '✧', 'Polishes interfaces, copy, prompts, and code expression so structure and form fit.', 0,
    ['ui-ux-pro-max', 'impeccable', 'ui-styling', 'minimalist-ui', 'high-end-visual-design', 'design-system']),
]);
