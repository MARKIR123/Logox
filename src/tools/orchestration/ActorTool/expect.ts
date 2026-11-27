/** Minutes in an `Actor` task's `expect` ("45m", "2h", "1h30m", "90min"); undefined when it is not a positive duration of at most a week. */
export function parseExpectMinutes(text: string): number | undefined {
  const match = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?$/i.exec(text.trim());
  if (!match || (match[1] === undefined && match[2] === undefined)) return undefined;
  const minutes = Math.round(Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0));
  return minutes > 0 && minutes <= 7 * 24 * 60 ? minutes : undefined;
}
