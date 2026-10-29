import {CORE_EXECUTION_CHARTER, ROUND_SUMMARY_CONTRACT, TASK_PROGRESS_RULE, TOOL_USAGE_RULES} from './charter.js';
import {COLLABORATION_COMMON, TASK_REPORT_CONTRACT} from './collaboration/index.js';
import {workingDirectory} from './runtime/environment.js';
import {getScratchpadPromptSection} from './runtime/scratchpad.js';

export const PROMPT_CACHE_BOUNDARY = '<!-- __LOGOX_PROMPT_CACHE_BOUNDARY__ -->';
export type PromptZone = 'static' | 'dynamic';
export type PromptTopic = 'persona' | 'execution' | 'collaboration' | 'tools-skills' | 'environment';
export interface PromptSection {
  readonly name: string;
  readonly text: string;
  readonly zone: PromptZone;
  readonly topic: PromptTopic;
  readonly owner: 'shared' | 'role' | 'resource' | 'runtime';
  readonly stability: 'stable' | 'revisioned' | 'live';
}
export interface ActorSystemPromptInput {
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
    if (text.trim()) sections.push({name, topic, owner, stability, zone: 'static', text: nested(text)});
  };
  add('persona', 'persona', 'role', input.persona);
  add('tool_rules', 'execution', 'shared', TOOL_USAGE_RULES);
  add('execution_charter', 'execution', 'shared', CORE_EXECUTION_CHARTER);
  add('activity_visibility', 'execution', 'shared', TASK_PROGRESS_RULE);
  if (input.includeSummary !== false) add('round_memory', 'execution', 'shared', ROUND_SUMMARY_CONTRACT);
  if (input.execution) add('role_execution', 'execution', 'role', input.execution);
  if (input.memoryFocus?.trim()) {
    const focus = input.memoryFocus.trim();
    add('memory_focus', 'execution', 'role', /^#{1,6}\s/.test(focus) ? focus : '## Role Memory Focus\n' + focus);
  }
  for (const guideline of input.guidelines) add('guidelines', 'execution', 'resource',
    '## Project and User Guidelines\nSource: ' + guideline.path + '\n\n' + nested(guideline.text), 'revisioned');
  add('collaboration', 'collaboration', 'shared', COLLABORATION_COMMON + '\n\n' + TASK_REPORT_CONTRACT);
  if (input.collaboration) add('role_collaboration', 'collaboration', 'role', input.collaboration);
  add('tools', 'tools-skills', 'resource', input.toolsIndex ? '## Tools\n' + input.toolsIndex : '', 'revisioned');
  add('skills', 'tools-skills', 'resource', input.skillsIndex ? '## Skills\n' + input.skillsIndex : '', 'revisioned');
  add('environment', 'environment', 'runtime', input.environmentBaseline, 'revisioned');
  const headings: readonly [PromptTopic, string][] = [
    ['persona', 'Persona'], ['execution', 'Execution Rules'], ['collaboration', 'Team Collaboration'],
    ['tools-skills', 'Tools & Skills'], ['environment', 'Current Environment'],
  ];
  return {system: headings.map(([topic, title]) => '# ' + title + '\n\n' +
    sections.filter(section => section.topic === topic).map(section => section.text).join('\n\n')).join('\n\n'), sections};
}

export function composeBaseSystemPrompt(options: BasePromptOptions): {system: string; sections: readonly PromptSection[]} {
  const builtin = options.builtinPrompt ?? '';
  const custom = options.customPrompt ?? '';
  const persona = custom && builtin && custom !== builtin && !custom.includes(builtin)
    ? builtin + '\n\n## Custom Persona Extension\n' + custom : custom || builtin;
  if (!persona) throw new Error('Actor has no valid persona: ' + options.ownerId);
  const environment = options.environmentBaseline ?? [workingDirectory(options.cwd),
    ...(options.scratchpadDir ? [getScratchpadPromptSection(options.scratchpadDir)] : [])].join('\n\n');
  return composeActorSystemPrompt({persona, execution: options.execution, collaboration: options.collaboration,
    memoryFocus: options.memoryFocus,
    guidelines: options.guidelines ?? (options.rulesContext ? [{path: 'request', text: options.rulesContext}] : []),
    toolsIndex: options.toolsIndex ?? '', skillsIndex: options.skillsIndex ?? '', environmentBaseline: environment,
    includeSummary: options.includeSummary});
}
