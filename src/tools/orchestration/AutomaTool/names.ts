/**
 * Optional worker names: short lowercase kebab-case handles (`scout`, `api-tests`) a dispatcher may give a job and use instead of its id (`T1`) later.
 * Pure: validation and lookup only; the shelf and the background board hold the names.
 */

export const NAME_MAX = 24;
export const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
/** What a readable worker id looks like (`T1`, `K12`); a name that read like one could shadow an id, so it is refused. */
const ID_LIKE = /^[a-z]\d+$/i;

/** True when `ref` has the shape of a readable worker id. */
export const looksLikeId = (ref: string): boolean => ID_LIKE.test(ref.trim());

/** The refusal (with its fix) for a name that does not follow the rules; undefined when it is valid. */
export function nameProblem(name: string): string | undefined {
  if (name.length > NAME_MAX) return `Worker name "${name}" is longer than ${NAME_MAX} characters. Fix: use a short handle such as "scout" or "api-tests".`;
  if (!NAME_PATTERN.test(name)) return `Worker name "${name}" is not lowercase kebab-case. Fix: start with a letter and use only a-z, 0-9 and "-", for example "scout" or "api-tests".`;
  if (ID_LIKE.test(name)) return `Worker name "${name}" reads like a worker id. Fix: pick a word such as "scout"; ids (T1) are assigned by the runtime.`;
  return undefined;
}

/** The refusal for a name another live or parked worker of the same dispatcher already holds. */
export const nameTaken = (name: string, holder: string): string =>
  `Worker name "${name}" is already used by ${holder}. Fix: pick another name, or \`continue\` "${name}" to give that worker its next step.`;
/** The refusal for one name given to two jobs of one call. */
export const nameTwice = (name: string): string => `Worker name "${name}" is given to two jobs of this call. Fix: give each job its own name.`;

/** Case-insensitive key of a name or id. */
export const refKey = (ref: string): string => ref.trim().toLowerCase();
