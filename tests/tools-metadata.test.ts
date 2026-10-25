import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isToolAllowedForActor,
  toolMetadataSchema,
  type ToolMetadata,
} from '../src/tools/metadata.js';

test('isToolAllowedForActor handles all role scoping modes seamlessly', () => {
  // 'all' permits director, built-in actors, and any newly created dynamic actor
  assert.equal(isToolAllowedForActor('all', 'logox'), true);
  assert.equal(isToolAllowedForActor('all', 'techne'), true);
  assert.equal(isToolAllowedForActor('all', 'custom-actor-99'), true);

  // 'director' permits only 'logox'
  assert.equal(isToolAllowedForActor('director', 'logox'), true);
  assert.equal(isToolAllowedForActor('director', 'techne'), false);
  assert.equal(isToolAllowedForActor('director', 'custom-actor-99'), false);

  // 'actors' permits all worker actors (built-in or dynamic) except 'logox'
  assert.equal(isToolAllowedForActor('actors', 'logox'), false);
  assert.equal(isToolAllowedForActor('actors', 'techne'), true);
  assert.equal(isToolAllowedForActor('actors', 'kalon'), true);
  assert.equal(isToolAllowedForActor('actors', 'custom-actor-99'), true);

  // Explicit array of actor names allows only matched names
  assert.equal(isToolAllowedForActor(['logox', 'techne'], 'logox'), true);
  assert.equal(isToolAllowedForActor(['logox', 'techne'], 'techne'), true);
  assert.equal(isToolAllowedForActor(['logox', 'techne'], 'kalon'), false);
  assert.equal(isToolAllowedForActor(['logox', 'techne'], 'custom-actor-99'), false);

  assert.equal(isToolAllowedForActor(['custom-actor-99'], 'custom-actor-99'), true);
  assert.equal(isToolAllowedForActor(['custom-actor-99'], 'techne'), false);
});

test('toolMetadataSchema validates and parses valid metadata', () => {
  const meta: ToolMetadata = {
    name: '_GitStatus',
    category: 'protocol',
    roles: 'all',
    promptVisibility: 'explicit',
    terminalVisibility: 'silent',
    description: 'Fetch concise git status',
  };

  const parsed = toolMetadataSchema.parse(meta);
  assert.equal(parsed.name, '_GitStatus');
  assert.equal(parsed.category, 'protocol');
  assert.equal(parsed.roles, 'all');
  assert.equal(parsed.terminalVisibility, 'silent');
});
