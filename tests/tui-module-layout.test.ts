import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';

const source = new URL('../../src/tui/', import.meta.url);
const output = new URL('../src/tui/', import.meta.url);
const layout: Record<string, string[]> = {
  appearance: ['actor-style.ts', 'animation.ts', 'colors.ts', 'theme.ts'],
  commands: ['command-menu.tsx', 'command-suggestions.tsx', 'completion.ts', 'query-match.ts'],
  components: ['card.tsx', 'list-frame.tsx', 'panel-frame.tsx', 'toggle-marker.ts'],
  input: ['editor.ts', 'fullscreen-editor.tsx', 'input-delivery.ts'],
  interactions: ['choice-style.ts', 'interaction-card.tsx', 'production-question.tsx', 'question-panel.tsx'],
  login: ['login.tsx', 'login-wizard.tsx'],
  panels: ['command-result.tsx', 'picker.tsx', 'tabbed-page.tsx', 'toggle-list.tsx'],
  previews: ['provider-wizard-preview.ts', 'question-preview.tsx', 'slash-preview.tsx'],
  status: ['actor-pills.tsx', 'statusbar-editor.tsx', 'statusbar.ts'],
  terminal: ['clipboard.ts', 'metrics.ts', 'mouse.ts', 'terminal-plane.ts', 'terminal.tsx', 'text.ts'],
  timeline: ['activity-card.tsx', 'actor-location.ts', 'markdown-table.ts', 'markdown.ts', 'row-presentation.ts',
    'scene-state.ts', 'scene.ts', 'selection.ts', 'stage.ts', 'thinking-groups.ts', 'tool-ui.ts', 'viewport.ts'],
};

const sourceModules = (directory: URL) => readdirSync(directory, {withFileTypes: true})
  .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name)).map(entry => entry.name).sort();
const outputModules = (directory: URL) => readdirSync(directory, {withFileTypes: true})
  .filter(entry => entry.isFile() && /(?:\.js(?:\.map)?|\.d\.ts)$/.test(entry.name)).map(entry => entry.name).sort();
const emitted = (files: string[]) => files.flatMap(file => ['.js', '.js.map', '.d.ts'].map(extension =>
  file.replace(/\.tsx?$/, extension))).sort();

test('UI source and build use responsibility-based directories with only two root entrypoints', () => {
  const entrypoints = ['app.tsx', 'application.tsx'];
  assert.deepEqual(sourceModules(source), entrypoints);
  assert.deepEqual(outputModules(output), emitted(entrypoints), 'Dirty builds remove retired root modules');
  for (const root of [source, output]) {
    const directories = readdirSync(root, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    assert.deepEqual(directories, Object.keys(layout).sort(), 'Only responsibility-based directories remain');
  }
  for (const [directory, files] of Object.entries(layout)) {
    assert.deepEqual(sourceModules(new URL(directory + '/', source)), [...files].sort(), directory + ' source ownership');
    assert.deepEqual(outputModules(new URL(directory + '/', output)), emitted(files), directory + ' build ownership');
  }
  for (const stem of ['dsh-command-suggestions', 'dsh-question-panel']) {
    for (const extension of ['.js', '.js.map', '.d.ts']) {
      assert.equal(existsSync(new URL(stem + '.test' + extension, import.meta.url)), false, stem + extension);
    }
  }
});

test('primitive controls have no business imports and production never imports previews', () => {
  for (const [directory, files] of Object.entries(layout)) {
    for (const name of files) {
      const file = new URL(directory + '/' + name, source);
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*\()\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!;
        if (!specifier.startsWith('.')) continue;
        const dependency = new URL(specifier, file);
        const local = dependency.pathname.startsWith(source.pathname) ? dependency.pathname.slice(source.pathname.length) : '../outside-tui';
        if (directory !== 'previews') assert.ok(!local.startsWith('previews/'), directory + '/' + name + ' imports an acceptance preview');
        if (directory === 'components') assert.match(local,
          /^(?:components\/|appearance\/theme\.js$|terminal\/(?:text|mouse)\.js$|input\/editor\.js$)/,
          name + ' must depend only on neutral UI foundations: ' + specifier);
      }
    }
  }
});

test('any retained third-party notices are preserved independently of module layout', () => {
  const name = 'THIRD-PARTY-LICENSES.txt';
  if (!existsSync(new URL(name, source))) {
    assert.equal(existsSync(new URL(name, output)), false, 'Dirty builds remove retired notices');
    return;
  }
  const license = readFileSync(new URL(name, source), 'utf8');
  assert.match(license, /Copyright \(c\) 2026, chimney \(ccch1mneyyy\)/);
  assert.match(license, /Permission is hereby granted/);
  assert.equal(readFileSync(new URL(name, output), 'utf8'), license);
});
