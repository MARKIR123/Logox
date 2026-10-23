/**
 * Prompt assembly pipeline with an explicit static/dynamic zone split.
 *
 * Static sections form the cacheable prefix and keep a fixed order per role.
 * Conditional runtime sections are appended only after the static prefix, so
 * changing them never invalidates the cached prefix.
 */

import {CORE_EXECUTION_CHARTER, ROUND_SUMMARY_CONTRACT, TASK_PROGRESS_RULE, TOOL_USAGE_RULES} from './charter.js';
import {collaborationFor} from './collaboration/index.js';
import {workingDirectory} from './runtime/environment.js';
import {getScratchpadPromptSection} from './runtime/scratchpad.js';
import {NO_VISION_NOTE} from './runtime/vision.js';

export const PROMPT_CACHE_BOUNDARY = '<!-- __LOGOX_PROMPT_CACHE_BOUNDARY__ -->';

export type PromptZone = 'static' | 'dynamic';
export interface PromptSection {
  readonly name: string;
  readonly text: string;
  readonly zone: PromptZone;
}

export interface BasePromptOptions {
  cwd: string;
  ownerId: string;
  builtinPrompt?: string | undefined;
  customPrompt?: string | undefined;
  memoryFocus?: string | undefined;
  rulesContext?: string | undefined;
  includeSummary?: boolean | undefined;
  scratchpadDir?: string | undefined;
}

/**
 * Assembles the cacheable base prompt. Order is part of the cache contract:
 * persona -> memory focus -> environment -> scratchpad -> tool rules ->
 * charter -> collaboration -> user/project guidelines.
 */
export function composeBaseSystemPrompt(options: BasePromptOptions): {system: string; sections: PromptSection[]} {
  const {cwd, ownerId, builtinPrompt, customPrompt, memoryFocus, rulesContext, includeSummary = true, scratchpadDir} = options;

  let resolvedPrompt = '';
  if (customPrompt) {
    if (builtinPrompt && customPrompt !== builtinPrompt && !customPrompt.includes(builtinPrompt)) {
      resolvedPrompt = builtinPrompt + '\n\n## Custom Persona Extension\n' + customPrompt;
    } else {
      resolvedPrompt = customPrompt;
    }
  } else {
    resolvedPrompt = builtinPrompt ?? '';
  }

  if (!resolvedPrompt) {
    throw new Error('Actor has no valid persona: ' + ownerId);
  }

  const charter = [CORE_EXECUTION_CHARTER, TASK_PROGRESS_RULE, ...(includeSummary ? [ROUND_SUMMARY_CONTRACT] : [])].join('\n');
  const sections: PromptSection[] = [
    {name: 'persona', text: resolvedPrompt, zone: 'static'},
    ...(memoryFocus?.trim() ? [{name: 'memory_focus', text: 'Role memory focus (guidance under the round memory contract):\n' + memoryFocus.trim(), zone: 'static' as const}] : []),
    {name: 'environment', text: workingDirectory(cwd), zone: 'static'},
    ...(scratchpadDir ? [{name: 'scratchpad', text: getScratchpadPromptSection(scratchpadDir), zone: 'static' as const}] : []),
    {name: 'tool_rules', text: TOOL_USAGE_RULES, zone: 'static'},
    {name: 'execution_charter', text: charter, zone: 'static'},
    {name: 'collaboration', text: collaborationFor(ownerId), zone: 'static'},
    ...(rulesContext ? [{name: 'rules_context', text: rulesContext, zone: 'static' as const}] : []),
  ];

  const system = sections.map(section => section.text).join('\n');
  return {system, sections};
}

/** Appends only conditional runtime sections after the static prefix. */
export function composeRuntimeSystemPrompt(options: {
  baseSystem: string;
  supportsVision?: boolean | undefined;
  progressInstruction?: string | undefined;
  recoveryInstruction?: string | undefined;
  deliveryInstruction?: string | undefined;
  finalizationInstruction?: string | undefined;
  handoffNotice?: string | undefined;
}): string {
  const parts = [options.baseSystem];

  if (options.supportsVision === false) {
    parts.push(NO_VISION_NOTE);
  }

  if (options.progressInstruction) {
    parts.push(options.progressInstruction);
  }

  if (options.recoveryInstruction) {
    parts.push('Recovery notice: ' + options.recoveryInstruction);
  }

  if (options.deliveryInstruction) parts.push(options.deliveryInstruction);
  if (options.handoffNotice) parts.push(options.handoffNotice);
  if (options.finalizationInstruction) parts.push(options.finalizationInstruction);
  return parts.join('\n');
}
