import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('weather card page', () => {
  it('provides a valid self-contained index.html', () => {
    const htmlPath = join(rootDir, 'index.html');
    assert.equal(existsSync(htmlPath), true, 'index.html must exist');
    const html = readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('<svg'), 'index.html must include inline SVG');
    assert.equal(
      /(?:src|href)\s*=\s*["'](?:https?:)?\/\/|url\(\s*["']?https?:\/\//i.test(html),
      false,
      'index.html must not reference external URLs'
    );
  });
});
