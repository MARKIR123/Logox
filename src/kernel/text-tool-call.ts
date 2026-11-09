/**
 * Some providers (Gemini through an OpenAI-compatible proxy) occasionally return a function call as plain text, e.g.
 * `call:default_api:Write{content:...,file_path:...}`, with no structured tool call. Such a turn executed nothing and is not a
 * delivery. Only names of tools offered in the request count, so prose that merely discusses code never matches.
 */
export function textToolCallName(text: string, offered: readonly {readonly name: string}[]): string | undefined {
  if (!text.includes('call:')) return undefined;
  const names = offered.map(tool => tool.name).filter(Boolean).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!names.length) return undefined;
  const match = new RegExp(`call:[A-Za-z_][\\w.-]*:(${names.join('|')})\\{`, 'u').exec(text);
  return match?.[1];
}
