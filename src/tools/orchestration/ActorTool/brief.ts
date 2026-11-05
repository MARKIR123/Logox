import type {TaskSpec} from './ActorTool.js';

/** Static labels of the structured brief block appended to the actor's assignment. */
export const BRIEF_LABELS = {
  deliverables: 'Deliverables',
  owns: 'You own (may change)',
  interfaces: 'Interfaces (shared contract)',
  acceptance: 'Acceptance',
  verified: 'Already verified (do not redo)',
} as const;
export const BRIEF_HEADER = 'Brief';

const list = (items: readonly string[]) => items.map(item => '- ' + item.replace(/\s+/g, ' ')).join('\n');

/** Renders the optional structured fields of a task as a compact labelled block; empty when none are set. */
export function renderBrief(task: Pick<TaskSpec, 'deliverables' | 'owns' | 'files' | 'interfaces' | 'acceptance' | 'verified'>): string {
  const owns = [...new Set([...task.owns ?? [], ...task.files ?? []])];
  const sections = [
    task.deliverables?.length ? `${BRIEF_LABELS.deliverables}:\n${list(task.deliverables)}` : '',
    owns.length ? `${BRIEF_LABELS.owns}:\n${list(owns)}` : '',
    task.interfaces ? `${BRIEF_LABELS.interfaces}:\n${task.interfaces}` : '',
    task.acceptance?.length ? `${BRIEF_LABELS.acceptance}:\n${list(task.acceptance)}` : '',
    task.verified?.length ? `${BRIEF_LABELS.verified}:\n${list(task.verified)}` : '',
  ].filter(Boolean);
  return sections.length ? `${BRIEF_HEADER}\n${sections.join('\n')}` : '';
}
