import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  ONBOARDING_VERSION,
  ONBOARDING_UNSEEN,
  parseOnboardingPrefs,
  readOnboardingPrefs,
  markOnboardingDone,
  markOnboardingSkipped,
  shouldOfferOnboarding,
} from '../src/config/onboarding-preferences.js';

test('parseOnboardingPrefs parses valid, malformed and empty JSON safely', () => {
  assert.deepEqual(parseOnboardingPrefs(''), ONBOARDING_UNSEEN);
  assert.deepEqual(parseOnboardingPrefs('{bad json'), ONBOARDING_UNSEEN);
  assert.deepEqual(parseOnboardingPrefs('null'), ONBOARDING_UNSEEN);
  assert.deepEqual(parseOnboardingPrefs('[]'), ONBOARDING_UNSEEN);

  // Completed record
  const completed = parseOnboardingPrefs(JSON.stringify({completed: true, version: 1}));
  assert.equal(completed.completed, true);
  assert.equal(completed.version, 1);
  assert.equal(completed.skipped, undefined);

  // Skipped record
  const skipped = parseOnboardingPrefs(JSON.stringify({completed: false, version: 1, skipped: true}));
  assert.equal(skipped.completed, false);
  assert.equal(skipped.version, 1);
  assert.equal(skipped.skipped, true);
});

test('shouldOfferOnboarding triggers only when unseen or version bumped, never when completed or skipped', () => {
  // Unseen (never completed)
  assert.equal(shouldOfferOnboarding(ONBOARDING_UNSEEN), true);
  assert.equal(shouldOfferOnboarding({completed: false, version: 0}), true);

  // Completed at current revision
  assert.equal(shouldOfferOnboarding({completed: true, version: ONBOARDING_VERSION}), false);

  // Completed at older revision (eligible again for new onboarding steps)
  assert.equal(shouldOfferOnboarding({completed: true, version: ONBOARDING_VERSION - 1}), true);

  // Explicitly skipped by user (Esc pressed)
  assert.equal(shouldOfferOnboarding({completed: false, version: ONBOARDING_VERSION, skipped: true}), false);
});

test('readOnboardingPrefs and markOnboardingDone/Skipped roundtrip safely in isolated home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logox-onboarding-test-'));
  try {
    // 1. Initial state is unseen
    const initial = readOnboardingPrefs(home);
    assert.deepEqual(initial, ONBOARDING_UNSEEN);
    assert.equal(shouldOfferOnboarding(initial), true);

    // 2. Mark skipped
    assert.equal(markOnboardingSkipped(ONBOARDING_VERSION, home), true);
    const skipped = readOnboardingPrefs(home);
    assert.equal(skipped.completed, false);
    assert.equal(skipped.skipped, true);
    assert.equal(shouldOfferOnboarding(skipped), false);

    // 3. Mark done (e.g. via /setup or completed wizard)
    assert.equal(markOnboardingDone(ONBOARDING_VERSION, home), true);
    const done = readOnboardingPrefs(home);
    assert.equal(done.completed, true);
    assert.equal(done.version, ONBOARDING_VERSION);
    assert.equal(done.skipped, undefined);
    assert.equal(shouldOfferOnboarding(done), false);
  } finally {
    await rm(home, {recursive: true, force: true});
  }
});
