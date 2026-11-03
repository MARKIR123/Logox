import {structuredPatch} from 'diff';
import type {SceneSegment} from './scene.js';
import type {ToolLine} from './tool-card.js';
import {palette} from '../appearance/theme.js';
import {faintColor} from '../appearance/colors.js';
import {layoutMarkdown} from './markdown.js';

/** Dependency-free, line-oriented highlighter: comments faint, strings, keywords, numbers. Good enough to read, never to parse. */
type Family = 'c' | 'hash' | 'json' | 'css' | 'plain';
const families: Record<string, Family> = {
  ts: 'c', tsx: 'c', js: 'c', jsx: 'c', mjs: 'c', cjs: 'c', java: 'c', go: 'c', rs: 'c', c: 'c', h: 'c', cpp: 'c', hpp: 'c', cs: 'c', kt: 'c', swift: 'c', php: 'c',
  py: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', rb: 'hash', yml: 'hash', yaml: 'hash', toml: 'hash', ps1: 'hash', mk: 'hash', ini: 'hash',
  json: 'json', jsonc: 'json', css: 'css', scss: 'css', html: 'plain', svg: 'plain',
};
const keywords = new Set(('import export from as default const let var function class extends implements interface type enum return if else for while do switch case break continue ' +
  'new this super async await yield try catch finally throw typeof instanceof in of void delete static public private protected readonly abstract declare namespace ' +
  'true false null undefined def lambda pass with is not and or elif except raise None True False self fn pub mut impl struct trait use mod match loop where crate ' +
  'func package go defer chan select range var nil int string bool float double long char final package throws echo fi then done').split(' '));
const jsonWords = new Set(['true', 'false', 'null']);

export function languageOf(path: string): Family {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return families[ext] ?? 'plain';
}

/** Tokenizes one line; `inBlock` carries a `/* … *\/` comment across lines. */
export function highlightLine(text: string, family: Family, inBlock = false): {segments: SceneSegment[]; inBlock: boolean} {
  const segments: SceneSegment[] = [];
  const faint = faintColor();
  const push = (value: string, color: string) => {
    if (!value) return;
    const last = segments.at(-1);
    if (last && last.color === color) segments[segments.length - 1] = {...last, text: last.text + value};
    else segments.push({text: value, color});
  };
  if (family === 'plain') return {segments: [{text, color: palette.fg}], inBlock: false};
  let i = 0;
  while (i < text.length) {
    if (inBlock) {
      const end = text.indexOf('*/', i);
      if (end < 0) {push(text.slice(i), faint); i = text.length;} else {push(text.slice(i, end + 2), faint); i = end + 2; inBlock = false;}
      continue;
    }
    const rest = text.slice(i);
    if ((family === 'c' || family === 'css') && rest.startsWith('/*')) {inBlock = true; push('/*', faint); i += 2; continue;}
    if ((family === 'c' && rest.startsWith('//')) || (family === 'hash' && rest.startsWith('#'))) {push(rest, faint); break;}
    const ch = text[i]!;
    if (ch === '"' || ch === '\'' || (ch === '`' && family === 'c')) {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      push(text.slice(i, Math.min(text.length, j + 1)), palette.syntaxString); i = j + 1; continue;
    }
    const number = /^(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(rest);
    if (number && (i === 0 || !/[\w$]/.test(text[i - 1]!))) {push(number[0], palette.syntaxNumber); i += number[0].length; continue;}
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const set = family === 'json' ? jsonWords : keywords;
      push(word[0], set.has(word[0]) ? palette.syntaxKeyword : palette.fg); i += word[0].length; continue;
    }
    push(ch, palette.fg); i++;
  }
  return {segments, inBlock};
}

/** Right-aligned faint line number, two spaces, then the (optionally highlighted) code. */
export function numberedLine(number: number | string, width: number, code: readonly SceneSegment[]): ToolLine {
  return {segments: [{text: String(number).padStart(width) + '  ', color: faintColor()}, ...code]};
}

/** Numbered, lightly colored rows for a code excerpt starting at `first`. */
export function codeLines(lines: readonly string[], first: number, path: string): ToolLine[] {
  const family = languageOf(path);
  const width = String(first + lines.length - 1).length;
  let inBlock = false;
  return lines.map((line, index) => {
    const tokens = highlightLine(line.replaceAll('\t', '  '), family, inBlock);
    inBlock = tokens.inBlock;
    return numberedLine(first + index, width, tokens.segments.length ? tokens.segments : [{text: ''}]);
  });
}

/** Markdown rendered through the timeline's Markdown layout: bold headings, quiet code, no line numbers. */
export function markdownLines(source: string, width: number): ToolLine[] {
  return layoutMarkdown(source, width).map(row => ({segments: row.pieces.map((piece): SceneSegment => ({
    text: piece.text, ...(piece.bold ? {bold: true} : {}), ...(piece.italic ? {italic: true} : {}),
    color: piece.muted ? palette.muted : piece.code ? palette.accent : palette.fg}))}));
}

export interface DiffStats {readonly added: number; readonly removed: number}
/** Diff rows with a right-aligned line-number gutter and a faint `⋯` row between hunks. `offset` shifts a patch computed on an excerpt to real file lines. */
export function diffLines(hunks: ReturnType<typeof structuredPatch>['hunks'], offset = 0): {lines: ToolLine[]; stats: DiffStats} {
  const lines: ToolLine[] = [];
  let added = 0, removed = 0;
  const last = hunks.at(-1);
  const biggest = last ? Math.max(last.oldStart + last.oldLines, last.newStart + last.newLines) + offset : 1;
  const width = Math.max(3, String(biggest).length);
  const faint = faintColor();
  for (const [index, hunk] of hunks.entries()) {
    if (index > 0) lines.push({separator: true, segments: [{text: ' '.repeat(width + 1) + '⋯', color: faint}]});
    let oldLine = hunk.oldStart + offset, newLine = hunk.newStart + offset;
    for (const raw of hunk.lines) {
      if (raw.startsWith('\\')) continue;
      const sigil = raw[0]!, content = raw.slice(1).replaceAll('\t', '  ');
      if (sigil === '-') {
        removed++;
        lines.push({bg: palette.diffRemovedBg, segments: [{text: String(oldLine++).padStart(width) + ' ', color: faint}, {text: '− ', color: palette.diffRemovedGutter, bold: true}, {text: content, color: palette.diffRemoved}]});
      } else if (sigil === '+') {
        added++;
        lines.push({bg: palette.diffAddedBg, segments: [{text: String(newLine++).padStart(width) + ' ', color: faint}, {text: '+ ', color: palette.diffAddedGutter, bold: true}, {text: content, color: palette.diffAdded}]});
      } else {
        oldLine++;
        lines.push({segments: [{text: String(newLine++).padStart(width) + '   ', color: faint}, {text: content, color: palette.muted}]});
      }
    }
  }
  return {lines, stats: {added, removed}};
}
