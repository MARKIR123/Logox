import test from 'node:test';
import assert from 'node:assert/strict';
import {
  confusablePairs, contrastRatio, hueDistance, hueOf, legibilityPairs, legibilityReport, relativeLuminance, semanticTokens, CONFUSABLE_HUE, GRAPHIC_CONTRAST, TEXT_CONTRAST,
} from '../src/config/theme-legibility.js';
import {defaultPalette, type ThemePalette} from '../src/config/theme-palette.js';
import {applyThemePreset, listThemes} from '../src/config/theme-presets.js';
import {legibilityRows, ratioText} from '../src/tui/panels/theme-layout.js';
import {palette} from '../src/tui/appearance/theme.js';
import {rowText} from '../src/tui/panels/theme-sample.js';

test('contrast follows WCAG: black on white is 21, identical colours are 1, and the ratio is symmetric', () => {
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(relativeLuminance('#ffffff'), 1);
  assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 1e-9);
  assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 1e-9, 'order does not matter');
  assert.ok(Math.abs(contrastRatio('#336699', '#336699') - 1) < 1e-9);
  // Known reference values: #777777 on white is the textbook 4.48:1, #767676 the first grey that reaches 4.5.
  assert.ok(Math.abs(contrastRatio('#777777', '#ffffff') - 4.48) < 0.01);
  assert.ok(contrastRatio('#767676', '#ffffff') >= TEXT_CONTRAST && contrastRatio('#777777', '#ffffff') < TEXT_CONTRAST);
  assert.ok(Math.abs(contrastRatio('#ff0000', '#ffffff') - 4.0) < 0.01);
  for (const [a, b] of [['#1C2330', '#E8E6E0'], ['#abcdef', '#012345'], ['#ff8800', '#0088ff']] as const) assert.equal(contrastRatio(a, b), contrastRatio(b, a));
});

test('hue is measured in degrees on the colour wheel, greys have none, and distance wraps around 360', () => {
  assert.equal(hueOf('#ff0000'), 0); assert.equal(hueOf('#00ff00'), 120); assert.equal(hueOf('#0000ff'), 240);
  assert.ok(Math.abs(hueOf('#ffff00')! - 60) < 1e-9);
  assert.equal(hueOf('#808080'), undefined, 'a grey has no hue'); assert.equal(hueOf('#777779'), undefined, 'a near-grey neither');
  assert.equal(hueDistance(350, 10), 20); assert.equal(hueDistance(10, 350), 20); assert.equal(hueDistance(0, 180), 180); assert.equal(hueDistance(90, 90), 0);
});

test('colours that differ by under 20 degrees of hue are confusable; greys and distant hues are not', () => {
  const tokens = {a: '#ff0000', b: '#ff2a00', c: '#00ff00', d: '#808080', e: '#fe0010'};
  const found = confusablePairs(tokens, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(found.map(pair => pair.a + '≈' + pair.b), ['a≈b', 'a≈e', 'b≈e']);
  assert.ok(found.every(pair => pair.distance < CONFUSABLE_HUE));
  assert.deepEqual(confusablePairs({a: '#ff0000', b: '#ffa000'}, ['a', 'b']), [], '37 degrees apart is distinct');
  assert.deepEqual(confusablePairs({a: '#ff0000', b: '#ff0000'}, ['a', 'b']).map(pair => pair.distance), [0], 'the same colour twice is the extreme case');
});

/** A theme that is bad on purpose: every pair is the background colour, every semantic colour the same orange. */
const bad: ThemePalette = {...defaultPalette,
  fg: '#202020', muted: '#222222', cardExpanded: '#202020', dreamText: '#aaaaaa', dreamCollapsed: '#aaaaaa', dreamMuted: '#aaaaaa', selectionFg: '#303030', selectionBg: '#303030',
  diffAdded: '#202020', diffAddedBg: '#202020', diffRemoved: '#202020', diffRemovedBg: '#202020', borderMuted: '#202020', bg: '#202020',
  accent: '#e08020', warning: '#e08020', user: '#e08020'};

test('the legibility report lists the ten pairs with their thresholds and counts the failures', () => {
  const good = legibilityReport(defaultPalette);
  assert.deepEqual(good.pairs.map(pair => pair.label), ['text', 'muted', 'muted on card', 'text on card', 'dream text', 'dream muted', 'selection', 'diff +', 'diff −', 'border']);
  assert.deepEqual(good.pairs.map(pair => pair.threshold), [4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 3, 3, 3]);
  assert.equal(TEXT_CONTRAST, 4.5); assert.equal(GRAPHIC_CONTRAST, 3);
  const report = legibilityReport(bad);
  assert.equal(report.failing, 10); assert.equal(report.summary, '10 below threshold');
  assert.ok(report.pairs.every(pair => !pair.ok && pair.ratio < pair.threshold));
  assert.ok(legibilityPairs({...defaultPalette, fg: '#ffffff', bg: '#000000'}).find(pair => pair.label === 'text')!.ok);
  assert.deepEqual(report.confusable.map(pair => pair.a + '≈' + pair.b), ['accent≈user', 'accent≈warning', 'user≈warning']);
  assert.ok(semanticTokens.includes('question') && semanticTokens.includes('link'));
});

test('the legibility block of a bad theme shows the failing pairs and the count in the warning colour, a good one says Legible', () => {
  const original = {...palette};
  try {
    applyThemePreset('logox-dark');
    const first = legibilityRows(70);
    assert.match(rowText(first[0]!), /^(Legible|\d+ below threshold)$/);
    // Force every pair to fail through the live palette, as a previewed theme would.
    Object.assign(palette, bad);
    const rows = legibilityRows(70);
    assert.equal(rowText(rows[0]!), '10 below threshold'); assert.equal(rows[0]![0]!.color, palette.warning);
    for (const label of ['text', 'muted', 'muted on card', 'text on card', 'dream text', 'dream muted', 'selection', 'diff +', 'diff −', 'border']) {
      const cell = rows.flat().find(seg => seg.text.startsWith(label + ' ') && /\d\.\d\d/.test(seg.text));
      assert.ok(cell, label + ' has a cell'); assert.equal(cell!.color, palette.warning, label + ' is below its threshold');
      assert.match(cell!.text, new RegExp('^' + label.replace(/[+]/g, '\\+') + ' +\\d+\\.\\d\\d$'));
    }
    const confusable = rows.filter(row => /≈/.test(rowText(row)));
    assert.deepEqual(confusable.map(rowText), ['accent ≈ user', 'accent ≈ warning', 'user ≈ warning']);
    assert.ok(confusable.every(row => row[0]!.color === palette.warning));
    // A passing pair is drawn in the success colour.
    Object.assign(palette, {...defaultPalette, fg: '#ffffff', bg: '#000000'});
    const mixed = legibilityRows(70).flat().find(seg => seg.text.startsWith('text ') && /\d\.\d\d/.test(seg.text))!;
    assert.equal(mixed.color, palette.success);
  } finally {Object.assign(palette, original);}
});

test('a shown ratio is cut, never rounded, so 4.50 means the pair really passes', () => {
  assert.equal(ratioText(4.4999), '4.49'); assert.equal(ratioText(4.5), '4.50'); assert.equal(ratioText(21), '21.00'); assert.equal(ratioText(3.0049), '3.00');
});

test('every shipped theme can be reported (the table the page and the docs refer to)', () => {
  const original = {...palette};
  try {
    for (const theme of listThemes().filter(item => item.source === 'shipped')) {
      const report = legibilityReport(applyThemePreset(theme.name));
      assert.equal(report.pairs.length, 10, theme.name);
      assert.equal(report.summary, report.failing === 0 ? 'Legible' : report.failing + ' below threshold', theme.name);
    }
  } finally {Object.assign(palette, original);}
});
