import type {ActorContext} from '../../../actors/ensemble.js';
import type {TaskSpec} from './ActorTool.js';

/** A prompt longer than this (characters) makes a single-task dispatch worth a brief check. */
export const BRIEF_CHECK_PROMPT_LIMIT = 1500;

/** One new task as the brief check reads it. */
export interface BriefCheckTask {
  readonly ownerId: string;
  readonly title: string;
  readonly prompt: string;
  readonly owns: readonly string[];
  readonly acceptance: readonly string[];
  readonly after: readonly string[];
  /** The plan node the task carries out, when it names one: what the plan says about it, to compare with the brief. */
  readonly node?: {readonly id: string; readonly title: string; readonly owner: string; readonly acceptance: readonly string[]} | undefined;
}
export interface BriefCheckInput {
  readonly tasks: readonly BriefCheckTask[];
  /** The display names of the companions that receive the briefs. */
  readonly companions: readonly string[];
}

/** What the check found: `clear`, `blocked` with the numbered gaps, or `failed` (never blocks a dispatch) with a one-line reason. */
export type BriefCheckOutcome =
  | {readonly status: 'clear'}
  | {readonly status: 'blocked'; readonly gaps: string}
  | {readonly status: 'failed'; readonly reason: string};

/** Runs the check; supplied by the application (`Tools.runBriefCheck()`), absent in minimal setups, where no check runs. */
export type BriefChecker = (input: BriefCheckInput, context: ActorContext) => Promise<BriefCheckOutcome>;

/** The check runs for a dispatch of new tasks (never `resumeTask`) that carries two or more of them or one prompt over the limit. */
export function briefCheckNeeded(tasks: readonly Pick<TaskSpec, 'prompt' | 'resumeTask'>[]): boolean {
  const fresh = tasks.filter(task => !task.resumeTask);
  return fresh.length >= 2 || fresh.some(task => task.prompt.length > BRIEF_CHECK_PROMPT_LIMIT);
}

/** The worker's one message: every task's fields, verbatim, and who receives them. */
export function renderBriefCheckInput(input: BriefCheckInput): string {
  const list = (items: readonly string[]) => items.length ? '\n' + items.map(item => '- ' + item.replace(/\s+/g, ' ')).join('\n') : ' none';
  const tasks = input.tasks.map((task, index) => [`## Task ${index + 1}: ${task.title}`, `Companion: ${task.ownerId}`, 'Prompt:', task.prompt,
    'Owns:' + list(task.owns), 'Acceptance:' + list(task.acceptance), 'After:' + list(task.after),
    ...task.node ? [`Plan node ${task.node.id}: ${task.node.title} (owner ${task.node.owner})`, 'Plan acceptance:' + list(task.node.acceptance)] : []].join('\n'));
  return [`Companions receiving these briefs: ${input.companions.join(', ')}.`, '', ...tasks.flatMap(task => [task, ''])].join('\n').trimEnd();
}
