import {ROUND_SUMMARY_CONTRACT, SHARED_EXECUTION_RULES} from './charter.js';
import {collaborationFor} from './collaboration/index.js';
import {workingDirectory} from './runtime/environment.js';
import {getScratchpadPromptSection} from './runtime/scratchpad.js';

/** Separates the fixed part of the system prompt from what can change. Providers split on it or remove it; models never see it. */
export const PROMPT_CACHE_BOUNDARY = '<!-- __LOGOX_PROMPT_CACHE_BOUNDARY__ -->';
export type PromptZone = 'static' | 'dynamic';
export type PromptTopic = 'persona' | 'execution' | 'collaboration' | 'guidelines' | 'tools-skills' | 'environment';
export interface PromptSection {
  readonly name: string;
  readonly text: string;
  readonly zone: PromptZone;
  readonly topic: PromptTopic;
  readonly owner: 'shared' | 'role' | 'resource' | 'runtime';
  readonly stability: 'stable' | 'revisioned' | 'live';
}
export interface ActorSystemPromptInput {
  ownerId: string;
  persona: string;
  execution?: string | undefined;
  collaboration?: string | undefined;
  memoryFocus?: string | undefined;
  guidelines: readonly {path: string; text: string}[];
  toolsIndex: string;
  skillsIndex: string;
  environmentBaseline: string;
  includeSummary?: boolean | undefined;
}
export interface BasePromptOptions {
  cwd: string;
  ownerId: string;
  builtinPrompt?: string | undefined;
  customPrompt?: string | undefined;
  execution?: string | undefined;
  collaboration?: string | undefined;
  memoryFocus?: string | undefined;
  rulesContext?: string | undefined;
  guidelines?: readonly {path: string; text: string}[] | undefined;
  toolsIndex?: string | undefined;
  skillsIndex?: string | undefined;
  environmentBaseline?: string | undefined;
  includeSummary?: boolean | undefined;
  scratchpadDir?: string | undefined;
}
const nested = (text: string) => text.trim().replace(/^# /gm, '## ');

export function composeActorSystemPrompt(input: ActorSystemPromptInput): {system: string; sections: readonly PromptSection[]} {
  if (!input.persona.trim()) throw new Error('Actor has no valid persona.');
  const sections: PromptSection[] = [];
  const add = (name: string, topic: PromptTopic, owner: PromptSection['owner'], text: string, stability: PromptSection['stability'] = 'stable') => {
    if (text.trim()) sections.push({name, topic, owner, stability, zone: ['persona', 'execution', 'collaboration'].includes(topic) ? 'static' : 'dynamic', text: nested(text)});
  };
  add('persona', 'persona', 'role', input.persona);
  add('shared_execution', 'execution', 'shared', SHARED_EXECUTION_RULES);
  if (input.includeSummary !== false) add('round_memory', 'execution', 'shared', ROUND_SUMMARY_CONTRACT);
  if (input.memoryFocus?.trim()) {
    const focus = input.memoryFocus.trim();
    add('memory_focus', 'execution', 'role', /^#{1,6}\s/.test(focus) ? focus : '## Role Memory Focus\n' + focus);
  }
  // Role rules follow the shared rules they build on, so they read as additions rather than being overridden.
  if (input.execution) add('role_execution', 'execution', 'role', input.execution);
  add('collaboration', 'collaboration', 'shared', collaborationFor(input.ownerId));
  if (input.collaboration) add('role_collaboration', 'collaboration', 'role', input.collaboration);
  for (const guideline of input.guidelines) add('guidelines', 'guidelines', 'resource',
    'Source: ' + guideline.path + '\n\n' + nested(guideline.text), 'revisioned');
  add('tools', 'tools-skills', 'resource', input.toolsIndex ? '## Tools\n' + input.toolsIndex : '', 'revisioned');
  add('skills', 'tools-skills', 'resource', input.skillsIndex ? '## Skills\n' + input.skillsIndex : '', 'revisioned');
  add('environment', 'environment', 'runtime', input.environmentBaseline, 'revisioned');
  const render = (topics: readonly [PromptTopic, string][]) => topics.map(([topic, title]) => '# ' + title + '\n\n' +
    sections.filter(section => section.topic === topic).map(section => section.text).join('\n\n')).join('\n\n');
  // Fixed text first, then what the user or the session can change, so a change never re-caches what could not have changed.
  return {system: render([['persona', 'Persona'], ['execution', 'Execution Rules'], ['collaboration', 'Team Collaboration']]) + '\n\n' + PROMPT_CACHE_BOUNDARY + '\n\n' +
    render([['guidelines', 'Project Guidelines'], ['tools-skills', 'Tools & Skills'], ['environment', 'Current Environment']]), sections};
}

export function composeBaseSystemPrompt(options: BasePromptOptions): {system: string; sections: readonly PromptSection[]} {
  const builtin = options.builtinPrompt ?? '';
  const custom = options.customPrompt ?? '';
  const persona = custom && builtin && custom !== builtin && !custom.includes(builtin)
    ? builtin + '\n\n## Custom Persona Extension\n' + custom : custom || builtin;
  if (!persona) throw new Error('Actor has no valid persona: ' + options.ownerId);
  const environment = options.environmentBaseline ?? [workingDirectory(options.cwd),
    ...(options.scratchpadDir ? [getScratchpadPromptSection(options.scratchpadDir)] : [])].join('\n\n');
  return composeActorSystemPrompt({ownerId: options.ownerId, persona, execution: options.execution, collaboration: options.collaboration,
    memoryFocus: options.memoryFocus,
    guidelines: options.guidelines ?? (options.rulesContext ? [{path: 'request', text: options.rulesContext}] : []),
    toolsIndex: options.toolsIndex ?? '', skillsIndex: options.skillsIndex ?? '', environmentBaseline: environment,
    includeSummary: options.includeSummary});
}
