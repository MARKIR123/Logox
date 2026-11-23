/**
 * Filler tolerance for model-facing tool input. Some models fill every field of a flat schema: `[]`, `""`, `null` and placeholder text for
 * fields the call does not use. These helpers are the one place that reads such input as "absent"; each tool's own normaliser
 * (`normalize.ts:normalizeToolInput()`) decides which fields it uses. Nothing here changes a schema that is sent to the model.
 */

export type Dict = Record<string, unknown>;

export const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value);

/** An empty array, an empty or blank string, `null` and `undefined` all mean "not given". */
export const isEmptyValue = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

/**
 * A copy of `input` without its empty values. Keys named in `keep` stay as they are (a field where an empty value means something,
 * such as the replacement text of an Edit). Anything that is not a plain object passes through untouched.
 */
export function dropEmpty<T>(input: T, keep: readonly string[] = []): T {
  if (!isDict(input)) return input;
  const result: Dict = {};
  for (const [key, value] of Object.entries(input)) if (keep.includes(key) || !isEmptyValue(value)) result[key] = value;
  return result as T;
}

/** A copy of `input` with only the listed keys; fields the mode does not use are ignored whatever their value. */
export function onlyFields<T>(input: T, fields: readonly string[]): T {
  if (!isDict(input)) return input;
  const result: Dict = {};
  for (const key of fields) if (Object.hasOwn(input, key)) result[key] = input[key];
  return result as T;
}

/** `dropEmpty()` on an object and on each object of the arrays named in `lists` (one level), for schemas like `{tasks: [{...}]}`. */
export function dropEmptyIn(input: unknown, lists: readonly string[], keep: readonly string[] = []): unknown {
  if (!isDict(input)) return input;
  const result = dropEmpty(input, keep);
  for (const list of lists) if (Array.isArray(result[list])) result[list] = (result[list] as unknown[]).map(item => dropEmpty(item, keep));
  return result;
}
