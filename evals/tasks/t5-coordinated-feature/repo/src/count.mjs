/**
 * Count case-insensitive word frequencies in a text string.
 * Returns a Map<string, number>.
 */
export function countWords(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Input text must be a string');
  }
  const counts = new Map();
  const tokens = text.toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) ?? [];
  for (const word of tokens) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}
