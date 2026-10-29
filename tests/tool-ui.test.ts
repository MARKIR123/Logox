import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {schemas} from '../src/tools/index.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {timelineRows} from '../src/tui/timeline/viewport.js';
import {cast} from '../src/actors/ensemble.js';
import {formatToolSummary, formatToolCardTitle, formatToolCardBody} from '../src/tools/ui-format.js';
import type {Interaction} from '../src/runtime/contracts.js';

async function registry() {
  const path = '../src/tools/ui-registry.js';
  const module = await import(path).catch(() => undefined);
  assert.ok(module, 'Built-in tools must expose a functioning UI registry');
  return module;
}

test('all built-in and collaboration tool names resolve to explicitly owned presentation', async () => {
  const {getToolUI, toolUIs} = await registry();
  for (const name of [...Object.keys(schemas), 'SendMessage']) {
    assert.ok(Object.hasOwn(toolUIs, name), name);
    assert.equal(getToolUI(name), toolUIs[name]);
    assert.equal(getToolUI(name).visibility, ['_FinishRound', '_GitStatus', 'LoadTools'].includes(name) ? 'hidden' : 'visible');
  }
  assert.equal(getToolUI('bash'), getToolUI('Shell'));
  assert.equal(getToolUI('read'), getToolUI('Read'));
  const fallback = getToolUI('ExternalTool');
  assert.equal(fallback.visibility, 'visible');
  assert.equal(fallback.title({id: 'x', name: 'ExternalTool', arguments: '{}'}), 'ExternalTool');
});

test('tool-owned titles retain intention and relevant arguments', async () => {
  const {getToolUI} = await registry();
  const title = (name: string, args: unknown) => getToolUI(name).title({id: 'x', name, arguments: JSON.stringify(args)});
  assert.equal(title('Read', {path: 'src/app.ts', description: 'Inspect source'}), 'Read · Inspect source (src/app.ts)');
  assert.equal(title('Shell', {command: 'npm test'}), 'Shell npm test');
  assert.equal(title('SendMessage', {to: 'techne', summary: 'Check cancellation'}), 'SendMessage to techne · Check cancellation · queued');
  assert.equal(title('Actor', {actor: 'techne', description: 'Fix cleanup'}), 'Actor · Fix cleanup (techne)');
  assert.equal(title('Actor', {tasks: [{ownerId: 'kalon', goal: 'Polish skyline'}]}), 'Actor · kalon (Polish skyline)');
  assert.equal(title('Grep', {pattern: 'needle', path: 'src'}), 'Grep needle');
  assert.equal(title('Glob', {pattern: '**/*.ts'}), 'Glob **/*.ts');
  assert.equal(title('AskUserQuestion', {questions: [{header: 'Themes', question: 'Which?'}]}), 'AskUserQuestion · Themes');

  // Outcome summary test (aligned with Claude Code ⎿ summaries)
  assert.equal(formatToolSummary('Read', '1: hello\n2: world\n3: !'), 'Read 3 lines');
  assert.equal(formatToolSummary('Read', '[Image file: test.png, size: 20480 bytes, format: image/png.]'), 'Image (20.0 KB PNG)');
  assert.equal(formatToolSummary('Write', 'Updated /path/to/file; use /undo to revert'), 'Wrote file successfully');
  assert.equal(formatToolSummary('Edit', 'Updated /path/to/file; use /undo to revert'), 'Applied 1 replacement');
  assert.equal(formatToolSummary('Glob', 'src/a.ts\nsrc/b.ts'), 'Found 2 files');
  assert.equal(formatToolSummary('Grep', 'src/a.ts:1: x\nsrc/b.ts:2: y'), 'Found 2 matches');
  assert.equal(formatToolSummary('Shell', 'Exit code: 0\nAll tests passed'), 'Exit code: 0');
  assert.equal(formatToolSummary('Shell', 'Exit code: 1\nCommand failed'), 'Exit code: 1');
});

test('internal finalization leaves no visible card or selectable surface in any tool state', () => {
  for (const state of ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const) {
    const store = new RuntimeStore();
    store.message('s', 'logox', 'assistant', 'Normal answer');
    const hidden = store.message('s', 'logox', 'notice', '_FinishRound\nprivate memory metadata', {
      kind: 'tool', step: {title: '_FinishRound', state, elapsedMs: 0},
    });
    const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 80, {[hidden]: true}, hidden);
    assert.ok(rows.some(row => row.text.includes('Normal answer')));
    assert.ok(rows.every(row => row.messageId !== hidden && !row.text.includes('_FinishRound') && !row.text.includes('private memory')));
    assert.ok(rows.every(row => row.action?.foldId !== hidden && !row.hits?.some(hit => hit.action.foldId === hidden)));
  }
});

test('fallback timeline omits hidden tool metadata before selection and wrapping', () => {
  const store = new RuntimeStore();
  store.message('s', 'logox', 'assistant', 'Normal answer');
  const hidden = store.message('s', 'logox', 'notice', '_FinishRound\nPRIVATE_METADATA_VALIDATION_ERROR', {
    kind: 'tool', step: {title: '_FinishRound', state: 'failed', elapsedMs: 0},
  });
  for (const width of [12, 80]) {
    const rows = timelineRows(store.getSnapshot().messages, width);
    assert.ok(rows.some(row => row.text.includes('Normal')));
    assert.ok(rows.every(row => !row.messageId.startsWith(hidden) && !row.text.includes('_Finish') && !row.text.includes('PRIVATE_')));
  }
});

test('question adapter owns selection, multi-question answers and custom input validation', async () => {
  const {getToolUI} = await registry();
  const adapter = getToolUI('AskUserQuestion').interaction;
  const request: Interaction = {sessionId: 's', ownerId: 'logox', activityId: 'a', requestId: 'q', status: 'pending',
    kind: 'question', title: 'Choose', questions: [
      {id: 'one', header: 'One', question: 'First?', options: [{id: 'yes', label: 'Yes', description: ''}]},
      {id: 'two', header: 'Two', question: 'Second?'},
    ]};
  let state = {request, draft: {questionIndex: 0, selected: 0, text: '', error: ''}, answers: {}};
  let next = adapter.reduce(state, {kind: 'move', delta: -1});
  assert.equal(next.draft.selected, 1);
  next = adapter.reduce({...state, ...next}, {kind: 'select', index: 0});
  next = adapter.reduce({...state, ...next}, {kind: 'submit'});
  assert.equal(next.complete, undefined); assert.equal(next.draft.questionIndex, 1);
  assert.deepEqual(next.answers, {one: {type: 'option', optionId: 'yes'}});
  state = {...state, ...next};
  const empty = adapter.reduce(state, {kind: 'submit'});
  assert.ok(empty.draft.error); assert.equal(empty.complete, undefined);
  next = adapter.reduce(state, {kind: 'text', text: 'Custom answer'});
  assert.equal(adapter.describe({...state, ...next}).editing, true);
  next = adapter.reduce({...state, ...next}, {kind: 'submit'});
  assert.equal(next.complete, true);
  assert.deepEqual(next.answers, {one: {type: 'option', optionId: 'yes'}, two: {type: 'text', text: 'Custom answer'}});
});

test('distribution asset build preserves user profiles and skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-build-isolation-'));
  try {
    const put = async (path: string, content: string) => {await mkdir(join(path, '..'), {recursive: true}); await writeFile(path, content);};
    const script = join(root, 'scripts', 'copy-actor-profiles.mjs');
    await put(script, await readFile(new URL('../../scripts/copy-actor-profiles.mjs', import.meta.url), 'utf8'));
    for (const actor of ['logox', 'techne', 'aletheia', 'kalon']) {
      await put(join(root, 'src', 'actors', 'profiles', actor, 'compression.md'), 'new bundled focus');
    }
    await put(join(root, 'src', 'resources', 'builtin-skills', 'public', 'agent.md'), 'new bundled skill');
    const toolSignpost = '---\ncategories:\n  custom: Custom inspection tools\n---\n';
    await put(join(root, 'src', 'tools', 'AGENTS.md'), toolSignpost);
    const statusbarPalettes = '{"gruvbox":{},"dracula":{}}';
    await put(join(root, 'src', 'config', 'statusbar-palettes.json'), statusbarPalettes);
    await put(join(root, 'dist', 'src', 'tools', 'AGENT.md'), 'retired category source');
    const noticeName = 'THIRD-PARTY-LICENSES.txt';
    const notice = await readFile(new URL('../../src/tui/' + noticeName, import.meta.url), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (notice !== undefined) await put(join(root, 'src', 'tui', noticeName), notice);
    await put(join(root, 'src', 'tools', 'bin', 'browser-shot.cmd'), 'fixture');
    await put(join(root, 'dist', 'src', 'tools', 'bin', 'browser-shot.cmd'), 'retired CLI');
    await put(join(root, 'dist', 'src', 'tools', 'BrowserShot', 'cli.js'), 'retired implementation');
    const home = join(root, 'home');
    const profile = join(home, '.logox-ts', 'actors', 'techne', 'compression.md');
    const skill = join(home, '.logox-ts', 'skills', 'public', 'agent.md');
    await put(profile, 'custom user focus'); await put(skill, 'custom user skill');
    const result = spawnSync(process.execPath, [script], {encoding: 'utf8', env: {...process.env, HOME: home, USERPROFILE: home}});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(root, 'dist', 'src', 'config', 'statusbar-palettes.json'), 'utf8'), statusbarPalettes);
    await assert.rejects(readFile(join(root, 'dist', 'src', 'tools', 'bin', 'browser-shot.cmd')), {code: 'ENOENT'});
    await assert.rejects(readFile(join(root, 'dist', 'src', 'tools', 'BrowserShot', 'cli.js')), {code: 'ENOENT'});
    assert.equal(await readFile(join(root, 'dist', 'src', 'actors', 'profiles', 'techne', 'compression.md'), 'utf8'), 'new bundled focus');
    assert.equal(await readFile(join(root, 'dist', 'src', 'tools', 'AGENTS.md'), 'utf8'), toolSignpost);
    await assert.rejects(readFile(join(root, 'dist', 'src', 'tools', 'AGENT.md')), {code: 'ENOENT'});
    if (notice !== undefined) assert.equal(await readFile(join(root, 'dist', 'src', 'tui', noticeName), 'utf8'), notice);
    assert.equal(await readFile(profile, 'utf8'), 'custom user focus');
    assert.equal(await readFile(skill, 'utf8'), 'custom user skill');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('completed tool cards format titles with coordinates and outcomes without ⎿ symbol', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'logox', kind: 'director', title: 'Task', status: 'running', stage: 'Run', detail: ''});
  store.message('s', 'logox', 'notice', 'Read\n1: const a = 1;\n2: const b = 2;\n3: const c = 3;', {
    activityId: 'a', kind: 'tool', step: {title: 'Read src/app.ts', state: 'completed', elapsedMs: 120, call: {id: '1', name: 'Read', arguments: JSON.stringify({file_path: 'src/app.ts'})}},
  });
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 80, {}, null);
  // Title contains path inside parenthesis and outcome outside; timing appended with '·'
  assert.ok(rows.some(row => row.text.includes('Read(src/app.ts) · 3 lines') && row.text.includes('0.1s')));
  // No ⎿ branch symbol
  assert.ok(rows.every(row => !row.text.includes('⎿')));
});

test('formatToolCardTitle handles slices, images, and diff summaries', () => {
  // Read slice
  assert.equal(
    formatToolCardTitle({id: '1', name: 'Read', arguments: JSON.stringify({file_path: 'src/tui/scene.ts', offset: 22, limit: 19})}),
    'Read(src/tui/scene.ts, lines 22-40)'
  );

  // Read image with size (outcome outside)
  assert.equal(
    formatToolCardTitle(
      {id: '2', name: 'Read', arguments: JSON.stringify({file_path: 'assets/logo.png'})},
      '[Image file: assets/logo.png, size: 20480 bytes, format: image/png. Visual content presented to model.]',
      true
    ),
    'Read(assets/logo.png) · 20.0 KB PNG'
  );

  // Read full file completed (outcome outside)
  assert.equal(
    formatToolCardTitle(
      {id: '3', name: 'Read', arguments: JSON.stringify({file_path: 'src/app.ts'})},
      Array.from({length: 143}, (_, i) => `${i + 1}: code`).join('\n'),
      true
    ),
    'Read(src/app.ts) · 143 lines'
  );

  // Edit with line differences (outcome outside)
  assert.equal(
    formatToolCardTitle({
      id: '4', name: 'Edit',
      arguments: JSON.stringify({file_path: 'src/app.ts', old_string: 'line1', new_string: 'line1\nline2\nline3'}),
    }, 'Updated src/app.ts', true),
    'Edit(src/app.ts) · Added 3 lines, removed 1 line'
  );

  // Shell with exit 0 (Option B: silent success, no redundant Exit 0)
  assert.equal(
    formatToolCardTitle(
      {id: '5', name: 'Shell', arguments: JSON.stringify({command: 'npm test'})},
      'Exit code: 0\nAll tests passed',
      true
    ),
    'Shell(npm test)'
  );

  // Shell with exit 1 (non-zero exit code outside)
  assert.equal(
    formatToolCardTitle(
      {id: '6', name: 'Shell', arguments: JSON.stringify({command: 'npm test'})},
      'Exit code: 1\nTests failed',
      true
    ),
    'Shell(npm test) · Exit 1'
  );

  // Path truncation from back to front
  assert.equal(
    formatToolCardTitle({
      id: '7', name: 'Write',
      arguments: JSON.stringify({
        file_path: 'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\logox-scratchpad\\45bca51707c7\\70115ebb-2ccf-4f15-8c3f-ab6eb5264655\\mkprobe.ps1',
        content: Array(59).fill('code').join('\n'),
      }),
    }),
    'Write(...\\45bca51707c7\\70115ebb..\\mkprobe.ps1) · 59 lines'
  );
});

test('formatToolCardBody limits read to 20 lines, formats image metadata and diff block', () => {
  // 143 lines read text capped at 20 lines
  const largeReadText = Array.from({length: 143}, (_, i) => `${i + 1}: line ${i + 1}`).join('\n');
  const readBody = formatToolCardBody({id: '1', name: 'Read', arguments: JSON.stringify({file_path: 'src/app.ts'})}, largeReadText);
  assert.equal(readBody.length, 21); // 20 lines + omission indicator
  assert.equal(readBody[0], '1: line 1');
  assert.equal(readBody[19], '20: line 20');
  assert.equal(readBody[20], '... (123 more lines omitted)');

  // Image body
  const imageBody = formatToolCardBody(
    {id: '2', name: 'Read', arguments: JSON.stringify({file_path: 'src/assets/logo.png'})},
    '[Image file: src/assets/logo.png, size: 20480 bytes, format: image/png. Visual content presented to model.]'
  );
  assert.ok(imageBody.some(line => line.includes('20.0 KB')));
  assert.ok(imageBody.some(line => line.includes('PNG')));

  // Edit diff body
  const editBody = formatToolCardBody(
    {id: '3', name: 'Edit', arguments: JSON.stringify({file_path: 'src/app.ts', old_string: 'old code', new_string: 'new code'})},
    'Updated src/app.ts'
  );
  assert.ok(editBody.some(line => line.startsWith('-') && line.includes('old code')));
  assert.ok(editBody.some(line => line.startsWith('+') && line.includes('new code')));
  assert.ok(!editBody.some(line => line.includes('---')));
});

test('Edit titles do not claim applied changes before successful completion', async () => {
  const call = {id: 'edit', name: 'Edit', arguments: JSON.stringify({file_path: 'style.css', old_string: 'old', new_string: 'new\nextra'})};
  const {getToolUI} = await registry();
  assert.equal(getToolUI('Edit').title(call), 'Edit(style.css)');
  assert.equal(formatToolCardTitle(call, 'No match found', false), 'Edit(style.css)');
});

for (const state of ['queued', 'running', 'waiting', 'cancelled', 'failed', 'completed'] as const) {
  const dispositions = state === 'completed' ? ['error', 'denied'] as const : [undefined];
  for (const disposition of dispositions) test(`unapplied Edit card (${state}, ${disposition ?? 'no disposition'}) shows diagnostics instead of an applied diff`, () => {
    const store = new RuntimeStore();
    const reason = disposition === 'denied' ? 'Permission rejected' : 'No match found for old_string; please re-read file';
    const id = store.message('s', 'techne', 'notice', 'Edit\n' + reason, {kind: 'tool', step: {
      title: 'Edit style.css', state, elapsedMs: 100, ...(disposition ? {disposition} : {}),
      call: {id: 'edit', name: 'Edit', arguments: JSON.stringify({file_path: 'style.css', old_string: 'PROPOSED_OLD', new_string: 'PROPOSED_NEW\nEXTRA_LINE'})},
    }});
    const rows = buildStageRows(store.getSnapshot(), 's', 'techne', 200, {[id]: true}, id);
    const display = rows.map(row => row.text).join('\n');
    assert.doesNotMatch(display, /Added|removed|Removed|PROPOSED_OLD|PROPOSED_NEW|EXTRA_LINE/);
    assert.ok(display.includes(reason), display);
    if (state === 'failed' || disposition) {
      const collapsed = buildStageRows(store.getSnapshot(), 's', 'techne', 200, {}, null);
      assert.ok(collapsed.some(row => row.text.includes(reason)), 'Failure reason should be visible without expanding the card');
    }
  });
}

test('expanded Edit card renders colored diff lines with line numbers and red/green background', () => {
  const store = new RuntimeStore();
  const id = store.message('s', 'techne', 'notice', 'Edit\nUpdated file', {
    activityId: 'a', kind: 'tool',
    step: {
      title: 'Edit README.md',
      state: 'completed',
      elapsedMs: 200,
      call: {
        id: '1',
        name: 'Edit',
        arguments: JSON.stringify({
          file_path: 'README.md',
          old_string: 'const oldVar = 1;',
          new_string: 'const newVar = 2;',
        }),
      },
    },
  });
  const rows = buildStageRows(store.getSnapshot(), 's', 'techne', 80, {[id]: true}, id);
  // Red line for removal
  const removedRow = rows.find(r => r.text.includes('const oldVar = 1;'));
  assert.ok(removedRow, 'Removed line should be present in rows');
  assert.equal(removedRow.bg, '#3E2A2C'); // palette.diffRemovedBg
  assert.ok(removedRow.segments?.some(s => s.text.includes('-') && s.color === '#B26671'));

  // Green line for addition
  const addedRow = rows.find(r => r.text.includes('const newVar = 2;'));
  assert.ok(addedRow, 'Added line should be present in rows');
  assert.equal(addedRow.bg, '#27392C'); // palette.diffAddedBg
  assert.ok(addedRow.segments?.some(s => s.text.includes('+') && s.color === '#57956B'));
});

test('SendMessage card formats as SendMessage to <actor> · description · queued with actor color', () => {
  const store = new RuntimeStore();
  const successId = store.message('s', 'logox', 'notice', 'SendMessage\nDelivered message to kalon.', {
    activityId: 'a', kind: 'tool',
    step: {
      title: 'SendMessage to kalon',
      state: 'completed',
      elapsedMs: 150,
      call: {
        id: 'msg-1',
        name: 'SendMessage',
        arguments: JSON.stringify({
          to: 'kalon',
          summary: 'Polish skyline',
          mode: 'queue',
          message: 'Please review and polish the skyline colors.',
        }),
      },
    },
  });
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 90, {}, null);
  const row = rows.find(r => r.messageId === successId);
  assert.ok(row);
  // Full text contains SendMessage to kalon · Polish skyline · queued
  assert.ok(row.text.includes('SendMessage to kalon · Polish skyline · queued'));
  // Icon is gray for success
  assert.equal(row.segments?.find(s => s.selectionKey === successId + ':icon')?.color, '#8D95A6');
  // Actor name kalon is rendered with kalon color (#e8a8dc) and bold
  const targetSeg = row.segments?.find(s => s.selectionKey === successId + ':title_target');
  assert.ok(targetSeg);
  assert.equal(targetSeg.text, 'kalon');
  assert.equal(targetSeg.color, cast.kalon.color);
  assert.equal(targetSeg.bold, true);

  // When hovered, the title segments brighten with the actor's highlight color
  const hoveredRows = buildStageRows(store.getSnapshot(), 's', 'logox', 90, {}, successId);
  const hoveredRow = hoveredRows.find(r => r.messageId === successId);
  assert.ok(hoveredRow);
  const hoveredTitleSeg = hoveredRow.segments?.find(s => s.selectionKey === successId + ':title');
  assert.ok(hoveredTitleSeg);
  assert.notEqual(hoveredTitleSeg.color, '#8D95A6');
});

test('SendMessage card turns leading square icon red on failure', () => {
  const store = new RuntimeStore();
  const failId = store.message('s', 'logox', 'notice', 'SendMessage\nTarget actor not found', {
    activityId: 'a', kind: 'tool',
    step: {
      title: 'SendMessage to unknown',
      state: 'failed',
      disposition: 'error',
      elapsedMs: 80,
      call: {
        id: 'msg-2',
        name: 'SendMessage',
        arguments: JSON.stringify({
          to: 'unknown',
          summary: 'Contact',
          message: 'Hello',
        }),
      },
    },
  });
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 90, {}, null);
  const row = rows.find(r => r.messageId === failId);
  assert.ok(row);
  // Leading icon ▮ uses the default error color on failure
  assert.equal(row.segments?.find(s => s.selectionKey === failId + ':icon')?.color, '#DA8A93');
  // Contains Error fault label
  assert.ok(row.text.includes('Error'));
});

test('expanded Edit card extracts surrounding file context lines when file exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-edit-context-'));
  const filePath = join(root, 'source.ts');
  const updatedLines = [
    'function setupApp() {',
    '  const config = load();',
    '  const logger = initLogger();',
    '  const newSetting = true;',
    '  const extraSetting = 100;',
    '  return config;',
    '}',
  ];
  await writeFile(filePath, updatedLines.join('\n'));

  const store = new RuntimeStore();
  const id = store.message('s', 'techne', 'notice', 'Edit\nUpdated', {
    activityId: 'a', kind: 'tool',
    step: {
      title: 'Edit source.ts',
      state: 'completed',
      elapsedMs: 100,
      call: {
        id: 'edit-ctx',
        name: 'Edit',
        arguments: JSON.stringify({
          file_path: filePath,
          old_string: '  const oldSetting = false;',
          new_string: '  const newSetting = true;\n  const extraSetting = 100;',
        }),
      },
    },
  });

  const rows = buildStageRows(store.getSnapshot(), 's', 'techne', 80, {[id]: true}, id);
  // Context lines from before the edit:
  assert.ok(rows.some(r => r.text.includes('function setupApp()')));
  assert.ok(rows.some(r => r.text.includes('const logger = initLogger()')));
  // Removed line:
  assert.ok(rows.some(r => r.text.includes('const oldSetting = false;')));
  // Added lines:
  assert.ok(rows.some(r => r.text.includes('const newSetting = true;')));
  assert.ok(rows.some(r => r.text.includes('const extraSetting = 100;')));
  // Context line from after the edit:
  assert.ok(rows.some(r => r.text.includes('return config;')));
  await rm(root, {recursive: true, force: true});
});
