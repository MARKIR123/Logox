import stringWidth from 'string-width';
const segmenter = new Intl.Segmenter('zh', {granularity: 'grapheme'});

/** Plain terminal text excludes control sequences; styling belongs to the renderer. */
export function safeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
export function clipLine(text: string, width: number): string {
  let result = '';
  for (const part of segmenter.segment(safeText(text))) {
    if (stringWidth(result + part.segment) > width) break;
    result += part.segment;
  }
  return result;
}
