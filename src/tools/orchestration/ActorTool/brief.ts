import type {TaskSpec} from './ActorTool.js';

/** Static labels of the brief block appended to the actor's assignment. */
export const BRIEF_LABELS = {
  owns: 'You own (may change)',
  acceptance: 'Acceptance',
} as const;
export const BRIEF_HEADER = 'Brief';

const list = (items: readonly string[]) => items.map(item => '- ' + item.replace(/\s+/g, ' ')).join('\n');

/** Renders the ownership and acceptance fields of a task as a compact labelled block; empty when none are set. */
export function renderBrief(task: Pick<TaskSpec, 'owns' | 'acceptance'>): string {
  const sections = [
    task.owns?.length ? `${BRIEF_LABELS.owns}:\n${list([...new Set(task.owns)])}` : '',
    task.acceptance?.length ? `${BRIEF_LABELS.acceptance}:\n${list(task.acceptance)}` : '',
  ].filter(Boolean);
  return sections.length ? `${BRIEF_HEADER}\n${sections.join('\n')}` : '';
}
