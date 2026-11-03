import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {readFileSync} from 'node:fs';
import {EMBLEM_PIXELS, EMBLEM_MASTER, EMBLEM_WORDMARK_PIXELS, emblemLines, masterLines, wordmarkLines, shadeEmblem, splashLines, EMBLEM_WORDMARK, EMBLEM_TAGLINE} from '../src/tui/appearance/emblem.js';

const colors = {blue: 'blue', bone: 'bone', title: 'title', muted: 'muted'};
const text = (line: readonly {text: string}[]) => line.map(segment => segment.text).join('');

test('the emblem is 26 square pixels per side: 13 rows of 26 half-block cells', () => {
  assert.equal(EMBLEM_PIXELS.length, 26);
  assert.ok(EMBLEM_PIXELS.every(row => row.length === 26 && /^[.bw]+$/.test(row)));
  const lines = emblemLines(colors);
  assert.equal(lines.length, 13);
  assert.ok(lines.every(line => stringWidth(text(line)) === 26));
  assert.ok(lines.some(line => line.some(segment => segment.color === 'blue')) && lines.some(line => line.some(segment => segment.color === 'bone')));
});

test('wide terminals put the words beside the emblem; narrow ones stack; tiny ones fall back to plain text', () => {
  const info = ['anthropic/claude-opus-5-5 · Type /help for assistance'];
  const wide = splashLines({width: 100, height: 30, colors, title: 'Session abc', info})!;
  assert.equal(wide.length, 15);
  assert.ok(wide.some(line => text(line).includes(EMBLEM_WORDMARK) && /[█▀▄]/.test(text(line))), 'wordmark sits on an emblem row');
  assert.ok(wide.every(line => stringWidth(text(line)) <= 100));
  const narrow = splashLines({width: 52, height: 34, colors, title: 'Session abc', info})!;
  assert.ok(narrow.findIndex(line => text(line).includes(EMBLEM_WORDMARK)) > 13, 'words come below the emblem');
  assert.ok(narrow.every(line => stringWidth(text(line)) <= 52));
  assert.ok(narrow.some(line => text(line).trim() === EMBLEM_TAGLINE));
  assert.equal(splashLines({width: 20, height: 40, colors, info}), undefined);
  assert.equal(splashLines({width: 120, height: 10, colors, info}), undefined);
});

const hexColors = {blue: '#7da1de', bone: '#e8e4da', title: '#7da1de', muted: '#8d95a6'};
const asset = (name: string) => JSON.parse(readFileSync(new URL(`../../assets/brand/${name}`, import.meta.url), 'utf8')) as string[];

test('the embedded master and wordmark equal the brand assets', () => {
  assert.deepEqual([...EMBLEM_MASTER], asset('master-52.json'));
  assert.deepEqual([...EMBLEM_WORDMARK_PIXELS], asset('wordmark-16.json'));
  assert.ok(EMBLEM_MASTER.length === 52 && EMBLEM_MASTER.every(row => row.length === 52));
  assert.ok(EMBLEM_WORDMARK_PIXELS.length === 16 && EMBLEM_WORDMARK_PIXELS.every(row => row.length === 72));
});

test('edge shading adds subtle tones to the master without moving pixels', () => {
  const shaded = shadeEmblem(EMBLEM_MASTER);
  assert.equal(shaded.length, 52);
  assert.ok(shaded.every((row, y) => row.length === 52 && [...row].every((c, x) => (c === '.') === (EMBLEM_MASTER[y]![x] === '.'))));
  const joined = shaded.join('');
  assert.ok(/[BWde]/.test(joined) && /[bw]/.test(joined));
  const lines = masterLines(hexColors);
  assert.equal(lines.length, 26);
  assert.ok(lines.every(line => stringWidth(text(line)) === 52));
  const used = new Set(lines.flatMap(line => line.flatMap(segment => [segment.color, segment.bg])).filter(Boolean));
  assert.ok(used.size > 2 && used.size <= 6, `tones ${used.size}`);
});

test('the wordmark is eight rows with a blue-to-bone gradient on the letters', () => {
  const lines = wordmarkLines(hexColors);
  assert.equal(lines.length, 8);
  assert.ok(lines.every(line => stringWidth(text(line)) === 72));
  assert.ok(lines[0]!.some(segment => segment.color === hexColors.blue || segment.bg === hexColors.blue));
  assert.notEqual(lines[1]!.find(segment => segment.color)?.color, lines[7]!.find(segment => segment.color)?.color);
});

test('the splash picks the largest layout that fits and never exceeds the width', () => {
  const info = ['anthropic/claude-opus-5-5 · Type /help for assistance'];
  const base = {colors: hexColors, title: 'Session abc', info, version: '0.1.0'};
  const rows = (lines: ReturnType<typeof splashLines>) => lines!.map(text);
  for (const [width, height] of [[160, 40], [134, 30], [110, 24], [108, 17], [100, 30], [60, 40], [40, 40]] as const) {
    const lines = splashLines({...base, width, height})!;
    assert.ok(lines.every(line => stringWidth(text(line)) <= width), `${width}x${height}`);
    assert.ok(lines.length <= height, `${width}x${height} rows`);
  }
  const large = rows(splashLines({...base, width: 160, height: 40}));
  assert.equal(large.length, 30);
  assert.ok(large.some(row => row.includes('◈ LOGOX  v0.1.0')) && large.some(row => row.includes('anthropic/claude-opus-5-5 · Type /help')));
  assert.ok(large.some(row => row.trim() === EMBLEM_TAGLINE) && large.some(row => row.includes('λόγος')));
  assert.ok(large.some(row => /[█▀▄]/.test(row) && row.length >= 52 + 6 + 72), 'wordmark beside the 52 emblem');
  const regular = rows(splashLines({...base, width: 120, height: 24}));
  assert.equal(regular.length, 17);
  assert.ok(regular.some(row => row.includes('◈ LOGOX')) && regular.some(row => row.trim() === EMBLEM_TAGLINE));
  assert.ok(splashLines({...base, width: 133, height: 40})!.length < 30, 'one column short of large drops to regular');
  assert.ok(rows(splashLines({...base, width: 100, height: 30})).some(row => row.includes(EMBLEM_WORDMARK)), 'small tier keeps the plain wordmark');
  assert.equal(splashLines({...base, width: 20, height: 40}), undefined);
  assert.equal(splashLines({...base, width: 160, height: 10}), undefined);
});

test('the splash emblem is the brand draft in assets/brand/draft-26.json', () => {
  const draft = JSON.parse(readFileSync(new URL('../../assets/brand/draft-26.json', import.meta.url), 'utf8')) as string[];
  assert.deepEqual([...EMBLEM_PIXELS], draft);
});
