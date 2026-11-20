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

/**
 * Return word frequencies as an array of `{ word, count }` objects sorted by
 * descending count and ascending alphabetical order on ties.
 */
export function getSortedWordCounts(text) {
  return [...countWords(text).entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .map(([word, count]) => ({word, count}));
}
