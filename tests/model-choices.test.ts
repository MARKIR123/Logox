import test from 'node:test';
import assert from 'node:assert/strict';
import {bindingChoices, INHERIT_CHOICE} from '../src/commands/model-choices.js';
import {groupModelsForProvider} from '../src/config/model-grouping.js';

const pool = [
  {provider: 'gateway', id: 'alpha-low'}, {provider: 'gateway', id: 'alpha-high'}, {provider: 'gateway', id: 'beta'},
  {provider: 'other', id: 'gamma', window: 200_000, isOffline: true},
];

test('the dedicated-model list is Inherit, then one row per model family, folded like the session picker', () => {
  const items = bindingChoices(undefined).items(pool);
  assert.equal(items[0]!.id, INHERIT_CHOICE);
  const families = ['gateway', 'other'].flatMap(provider => groupModelsForProvider(pool.filter(model => model.provider === provider).map(model => model.id), provider, '').map(family => family.baseModel));
  assert.deepEqual(items.slice(1).map(item => item.label), families, 'the same families the session picker shows');
  assert.ok(items.length - 1 <= pool.length);
  assert.deepEqual([...new Set(items.slice(1).map(item => item.group))], ['gateway', 'other']);
  assert.match(items.at(-1)!.description ?? '', /200k.*\[offline\]/);
});

test('two pickers built from the same pool offer the same rows whatever each is bound to', () => {
  const actor = bindingChoices({provider: 'gateway', model: 'beta'}), automa = bindingChoices(undefined);
  assert.deepEqual(actor.items(pool).map(item => [item.id, item.label, item.group]), automa.items(pool).map(item => [item.id, item.label, item.group]));
  assert.equal(automa.current, INHERIT_CHOICE);
  assert.equal(actor.current, JSON.stringify({provider: 'gateway', model: 'beta'}));
});

test('a choice resolves to its binding: Inherit clears, a family row picks the variant for the chosen effort, an unknown id is refused', () => {
  const choices = bindingChoices(undefined);
  const items = choices.items(pool);
  assert.equal(choices.resolve(INHERIT_CHOICE), undefined);
  const beta = items.find(item => item.label === 'beta')!;
  assert.deepEqual(choices.resolve(beta.id), {provider: 'gateway', model: 'beta'});
  assert.deepEqual(choices.resolve(JSON.stringify({provider: 'gateway', model: 'alpha-high'})), {provider: 'gateway', model: 'alpha-high'}, 'an exact variant id is accepted');
  assert.equal(choices.resolve(JSON.stringify({provider: 'nowhere', model: 'x'})), null);
});
