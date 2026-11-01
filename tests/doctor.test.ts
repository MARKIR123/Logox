import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runDoctorChecks, formatDoctorReport, detectActorProfiles, detectCredentials} from '../src/doctor.js';

test('runDoctorChecks executes all baseline diagnostic checks', () => {
  const report = runDoctorChecks();
  assert.ok(Array.isArray(report.checks));
  assert.ok(report.checks.length >= 6);

  const checkNames = report.checks.map(c => c.name);
  assert.ok(checkNames.includes('Node.js Runtime'));
  assert.ok(checkNames.includes('Terminal Capabilities'));
  assert.ok(checkNames.includes('Bundled ripgrep'));
  assert.ok(checkNames.includes('Playwright Chromium'));
  assert.ok(checkNames.includes('Actor Profiles'));
  assert.ok(checkNames.includes('Model Credentials'));

  const nodeCheck = report.checks.find(c => c.name === 'Node.js Runtime')!;
  assert.equal(nodeCheck.status, 'pass');
  assert.match(nodeCheck.message, /^v\d+/);

  const rgCheck = report.checks.find(c => c.name === 'Bundled ripgrep')!;
  assert.equal(rgCheck.status, 'pass');
  assert.match(rgCheck.message, /ripgrep/i);
});

test('formatDoctorReport produces readable CLI output with font verification strip', () => {
  const report = runDoctorChecks();
  const formatted = formatDoctorReport(report);

  assert.ok(formatted.includes('Logox Doctor'));
  assert.ok(formatted.includes('Node.js Runtime'));
  assert.ok(formatted.includes('Font & Powerline Alignment Check'));
  assert.ok(formatted.includes(' ◈ Logox  ⊞ Techne  ✧ Kalon  ◎ Aletheia '));
});

test('detectActorProfiles finds core profiles when installed', () => {
  const result = detectActorProfiles();
  assert.ok(Array.isArray(result.installed));
  assert.ok(Array.isArray(result.missing));
});

test('detectCredentials checks environment and auth files safely', () => {
  const result = detectCredentials();
  assert.ok(Array.isArray(result.envFound));
  assert.equal(typeof result.dotEnvFound, 'boolean');
  assert.ok(Array.isArray(result.authStorageFound));
});

test('runDoctorChecks warns about a retired ~/.logox-ts directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logox-doctor-home-'));
  try {
    assert.equal(runDoctorChecks(process.cwd(), home).checks.some(c => c.name === 'Legacy Directory'), false);
    await mkdir(join(home, '.logox-ts'));
    const check = runDoctorChecks(process.cwd(), home).checks.find(c => c.name === 'Legacy Directory');
    assert.equal(check?.status, 'warn');
    assert.equal(check?.message, 'Legacy ~/.logox-ts directory found; it is no longer read. Move anything you need into ~/.logox and delete it.');
  } finally {await rm(home, {recursive: true, force: true});}
});
