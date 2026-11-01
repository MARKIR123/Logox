export type ConversationLanguage = 'Chinese' | 'Japanese' | 'Korean' | 'English';

const MIN_LETTERS = 2;
const strip = (text: string) => text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ')
  .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ').replace(/(?:[A-Za-z]:)?[\w.\-]*[\/]\S*/g, ' ');

/** Classify human-authored text by script. Returns undefined when too short or ambiguous (code, paths, emoji). */
export function detectConversationLanguage(text: string): ConversationLanguage | undefined {
  const clean = strip(text);
  const count = (pattern: RegExp) => clean.match(pattern)?.length ?? 0;
  const han = count(/\p{Script=Han}/gu), kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = count(/\p{Script=Hangul}/gu), latin = count(/[A-Za-z]/g);
  if (kana > 0 && kana + han >= MIN_LETTERS) return 'Japanese';
  if (hangul >= MIN_LETTERS && hangul >= han) return 'Korean';
  if (han >= 3 && han * 2 >= count(/[A-Za-z]{2,}/g)) return 'Chinese';
  if (latin >= 6 && han + kana + hangul === 0) return 'English';
  return undefined;
}

/** Most recent confident detection among human-authored inputs, oldest to newest. */
export function sessionLanguage(humanInputs: readonly string[]): ConversationLanguage | undefined {
  for (let index = humanInputs.length - 1; index >= 0; index--) {
    const detected = detectConversationLanguage(humanInputs[index]!);
    if (detected) return detected;
  }
  return undefined;
}
