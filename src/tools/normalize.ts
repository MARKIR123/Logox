import {dropEmpty, dropEmptyIn, isDict, type Dict} from './filler.js';
import {canonicalToolName} from './types.js';
import {normalizePlanInput} from './coordination/PlanTool/PlanTool.js';

/**
 * The one place that reads filler (`[]`, `""`, `null` in fields a call does not use) as absent, per tool. It runs before a schema parses the
 * input, at every site that parses (validation, execution, service tools), and is idempotent. Fields where empty is a real value stay:
 * Edit and Write text, Plan `note`/`after`/`acceptance` on a bare update (see `PlanTool.ts:normalizePlanInput()`), an option description.
 * Tool schemas sent to the model are not touched. Automa has its own, larger front door (`AutomaTool.ts:normalizeAutomaInput()`).
 */
export function normalizeToolInput(tool: string, input: unknown): unknown {
  if (!isDict(input)) return input;
  switch (canonicalToolName(tool) ?? tool) {
    case 'Plan': return normalizePlanInput(input);
    case 'Actor': return dropEmptyIn(input, ['tasks']);
    case 'SendMessage': case 'CancelActor': return dropEmpty(input);
    case 'Edit': return dropEmpty(input, ['old_string', 'new_string', 'old_text', 'new_text']);
    case 'AskUserQuestion': return askQuestions(input);
    default: return input;
  }
}

/** Questions without an `options` array (empty or null) are free-text questions; an option keeps its (possibly empty) description. */
function askQuestions(input: Dict): Dict {
  const next = dropEmpty(input);
  if (Array.isArray(next.questions)) next.questions = next.questions.map(question => dropEmpty(question));
  return next;
}
