import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeStore} from '../src/runtime/store.js';
import {Ensemble} from '../src/actors/ensemble.js';
import {Journal} from '../src/store/journal.js';
import {executeShell, isSleep, shellSchema} from '../src/tools/ShellTool/ShellTool.js';
import {executeShellJob} from '../src/tools/ShellJobTool/ShellJobTool.js';
import {jobEndedNotice, jobStalledNotice} from '../src/tools/ShellJobTool/prompt.js';
import {backgroundTuning, killBackgroundJobs, listBackgroundJobs, looksInteractive, onBackgroundJobEvent, startBackgroundProcess, stopBackgroundJob,
  type BackgroundJobEvent, type JobMetadata} from '../src/tools/process.js';
import {createShellJobs, lastLines} from '../src/app/shell-jobs.js';
import {waitFor} from './wait-for.js';

const node = process.platform === 'win32' ? `& '${process.execPath}'` : `'${process.execPath}'`;
const alive = (pid: number) => {try {process.kill(pid, 0); return true;} catch {return false;}};
const shellArgs = (command: string): [string, string[]] => process.platform === 'win32'
  ? ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]] : ['/bin/sh', ['-c', command]];

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-jobs-'));
  let counter = 0;
  const script = async (code: string) => {const name = `s${++counter}.js`; await writeFile(join(cwd, name), code); return node + ' ' + name;};
  return {cwd, script, cleanup: async (...sessions: string[]) => {for (const session of sessions) killBackgroundJobs(undefined, session); await rm(cwd, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});}};
}
async function start(command: string, cwd: string, metadata: JobMetadata) {
  const [exe, args] = shellArgs(command);
  return startBackgroundProcess(exe, args, cwd, metadata, 50);
}
const collect = (sessionId: string) => {
  const events: BackgroundJobEvent[] = [];
  const stop = onBackgroundJobEvent(sessionId, event => {events.push(event);});
  return {events, stop};
};

test('a background job outlives the companion activity that started it', {timeout: 20_000}, async () => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'logox-jobs-j-'));
  try {
    const store = new RuntimeStore();
    let pid = 0;
    const ensemble = new Ensemble('s-live', store, new Journal(directory), async (_prompt, context) => {
      const job = await start(await f.script('setInterval(() => {}, 1000);'), f.cwd, {sessionId: 's-live', activityId: context.activityId, ownerId: context.ownerId, toolId: 'c1'});
      pid = job.pid;
      context.say('started');
    });
    await ensemble.dispatch('techne', 'train').done;
    assert.ok(pid > 0);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(alive(pid), 'the job is still running after its activity settled');
    assert.equal(listBackgroundJobs('s-live').filter(job => job.exitCode === undefined).length, 1);
    await ensemble.close();
    await waitFor(() => alive(pid), running => !running, {label: 'session close kills the job'});
  } finally {await f.cleanup('s-live'); await rm(directory, {recursive: true, force: true});}
});

test('the exit notice goes into the starting actor\'s task while it is still open', {timeout: 20_000}, async () => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'logox-jobs-j-'));
  try {
    const store = new RuntimeStore();
    let release!: () => void;
    const parked = new Promise<void>(resolve => {release = resolve;});
    let started!: () => void;
    const ready = new Promise<void>(resolve => {started = resolve;});
    const ensemble = new Ensemble('s-open', store, new Journal(directory), async (_prompt, context) => {
      await start(await f.script("console.log('training done'); setTimeout(() => process.exit(0), 300);"), f.cwd, {sessionId: 's-open', activityId: context.activityId, ownerId: context.ownerId, toolId: 'c1'});
      started();
      await parked;
      context.say('continued');
    });
    const director: string[] = [];
    const jobs = createShellJobs({sessionId: 's-open', nameOf: id => id.toUpperCase(), closed: () => false,
      deliverToTask: (owner, activity, text, summary) => ensemble.injectTaskMessage(owner, text, 'runtime', summary, 'queue', {activityId: activity}),
      notifyDirector: async text => {director.push(text);}});
    const handle = ensemble.dispatch('techne', 'train');
    await ready;
    await waitFor(() => store.getSnapshot().messages.filter(message => message.text?.includes('[Background job job-')).length, count => count === 1, {label: 'notice in the open task'});
    const notice = store.getSnapshot().messages.find(message => message.text?.includes('[Background job job-'))!;
    assert.match(notice.text!, /exited with code 0/);
    assert.match(notice.text!, /training done/);
    assert.equal(director.length, 0, 'an open task gets it, the Director does not');
    release();
    await handle.done;
    jobs.dispose();
    await ensemble.close();
  } finally {await f.cleanup('s-open'); await rm(directory, {recursive: true, force: true});}
});

test('the exit notice goes to the Director when the task has ended, once, naming the actor', {timeout: 20_000}, async () => {
  const f = await fixture();
  const session = 's-ended';
  const sent: {text: string; source: string}[] = [], tasks: string[] = [];
  const jobs = createShellJobs({sessionId: session, nameOf: id => id === 'techne' ? 'Techne' : id, closed: () => false,
    deliverToTask: async (_owner, _activity, text) => {tasks.push(text); return false;},
    notifyDirector: async (text, source) => {sent.push({text, source});}});
  try {
    await start(await f.script("console.log('done'); setTimeout(() => process.exit(2), 200);"), f.cwd, {sessionId: session, activityId: 'a1', ownerId: 'techne', toolId: 'c1'});
    await waitFor(() => sent.length, count => count >= 1, {label: 'director notice'});
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(sent.length, 1, 'delivered exactly once');
    assert.equal(sent[0]!.source, 'techne');
    assert.match(sent[0]!.text, /failed with exit code [12]/);
    assert.match(sent[0]!.text, /Started by: Techne \(techne\)/);
    assert.match(sent[0]!.text, /task that started it has ended/);
    assert.equal(tasks.length, 1, 'the task was tried first');
    assert.equal(jobs.running(), 0);
  } finally {jobs.dispose(); await f.cleanup(session);}
});

test('a ShellJob stop by the owner suppresses the exit notice; a closing session delivers nothing', {timeout: 20_000}, async () => {
  const f = await fixture();
  const session = 's-stop', {events, stop} = collect(session);
  try {
    const job = await start(await f.script('setInterval(() => {}, 1000);'), f.cwd, {sessionId: session, activityId: 'a1', ownerId: 'techne'});
    const result = await executeShellJob({id: job.id, stop: true}, session);
    assert.match(result.text, /stopp/);
    await waitFor(() => alive(job.pid), running => !running);
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(events.length, 0);

    const closing: string[] = [];
    let closed = false;
    const jobs = createShellJobs({sessionId: session, nameOf: id => id, closed: () => closed, deliverToTask: async (_o, _a, text) => {closing.push(text); return true;}, notifyDirector: async text => {closing.push(text);}});
    await start(await f.script('setTimeout(() => process.exit(0), 300);'), f.cwd, {sessionId: session, activityId: 'a1', ownerId: 'techne'});
    closed = true;
    await new Promise(resolve => setTimeout(resolve, 1800));
    assert.equal(closing.length, 0);
    jobs.dispose();
  } finally {stop(); await f.cleanup(session);}
});

test('the log file holds the whole output while the notice carries only the last lines', {timeout: 30_000}, async () => {
  const f = await fixture();
  const session = 's-log', {events, stop} = collect(session), logFile = join(f.cwd, 'logs', 'job.log');
  try {
    const command = await f.script("for (let i = 1; i <= 6000; i++) console.log('line ' + i + ' ' + 'x'.repeat(20));");
    const job = await start(command, f.cwd, {sessionId: session, activityId: 'a1', ownerId: 'techne', logFile});
    await waitFor(() => events.length, count => count === 1, {label: 'exit event'});
    const log = await readFile(logFile, 'utf8');
    assert.match(log, /^line 1 /);
    assert.match(log, /line 6000 /);
    assert.equal(log.split('\n').filter(line => line.startsWith('line ')).length, 6000);
    assert.ok(job.unread.length <= 32_000, 'unread output stays bounded');
    const tail = lastLines(job.tail);
    assert.equal(tail.split('\n').length, 40);
    const notice = jobEndedNotice({id: job.id, command: job.command, starter: 'Techne', runMs: 65_000, exitCode: 0, tail, logPath: logFile, audience: 'owner'});
    assert.ok(notice.includes(logFile));
    assert.match(notice, /Run time: 1m 5s/);
    assert.match(notice, /Continue your task/);
  } finally {stop(); await f.cleanup(session);}
});

test('a foreground command that outlives the threshold moves to the background in place', {timeout: 30_000}, async () => {
  const f = await fixture();
  const session = 's-auto', {events, stop} = collect(session), logFile = join(f.cwd, 'auto.log');
  try {
    const command = await f.script("console.log('first'); setTimeout(() => {console.log('last'); process.exit(0);}, 2500);");
    const metadata = {sessionId: session, activityId: 'a1', toolId: 'call-auto', ownerId: 'techne', logFile};
    const started = Date.now();
    const result = await executeShell(shellSchema.parse({command, timeout: 600}), f.cwd, new AbortController().signal, metadata, 700);
    assert.ok(Date.now() - started < 2300, 'returned at the threshold, not at the end');
    assert.equal(result.isError, false);
    const id = /moved to background job (job-\d+) \(pid (\d+)\)/.exec(result.text);
    assert.ok(id, result.text);
    assert.match(result.text, /You will be notified when it ends; do not poll or sleep/);
    assert.match(result.text, /first/);
    assert.ok(alive(Number(id[2])));
    await waitFor(() => events.length, count => count === 1, {label: 'exit notice after auto-background'});
    assert.equal(events[0]!.job.autoBackgrounded, true);
    assert.equal(events[0]!.job.exitCode, 0);
    assert.match(await readFile(logFile, 'utf8'), /first[\s\S]*last/);
    assert.match((await executeShellJob({id: id[1]!}, session)).text, /exited with code 0/);
  } finally {stop(); await f.cleanup(session);}
});

test('sleep is never auto-backgrounded, 0 disables it, and a shorter timeout still wins', {timeout: 30_000}, async () => {
  const f = await fixture();
  const session = 's-exempt';
  try {
    assert.ok(isSleep('sleep 30') && isSleep('  Start-Sleep -Seconds 5') && isSleep('& sleep 1'));
    assert.ok(!isSleep('sleeper.sh') && !isSleep('python train.py') && !isSleep('echo sleep'));
    const metadata = {sessionId: session, activityId: 'a1', ownerId: 'techne'};
    const sleepCommand = process.platform === 'win32' ? 'Start-Sleep -Seconds 5' : 'sleep 5';
    await assert.rejects(executeShell(shellSchema.parse({command: sleepCommand, timeout: 700}), f.cwd, new AbortController().signal, metadata, 200), /timed out/);
    assert.equal(listBackgroundJobs(session).length, 0, 'no job was created');

    const slow = await f.script("setTimeout(() => {console.log('end'); process.exit(0);}, 1200);");
    const plain = await executeShell(shellSchema.parse({command: slow, timeout: 600}), f.cwd, new AbortController().signal, metadata, 0);
    assert.match(plain.text, /Exit code: 0/);
    assert.equal(listBackgroundJobs(session).length, 0, '0 never backgrounds');

    await assert.rejects(executeShell(shellSchema.parse({command: await f.script('setInterval(() => {}, 1000);'), timeout: 700}), f.cwd, new AbortController().signal, metadata, 5000), /timed out/);
    assert.equal(listBackgroundJobs(session).length, 0, 'a timeout below the threshold kills the command as before');
  } finally {await f.cleanup(session);}
});

test('a job waiting at an interactive prompt is reported once; a merely slow one stays quiet', {timeout: 30_000}, async () => {
  const f = await fixture();
  const session = 's-stall', {events, stop} = collect(session);
  const saved = {...backgroundTuning};
  Object.assign(backgroundTuning, {stallMs: 400, stallCheckMs: 50});
  try {
    const stuck = await start(await f.script("process.stdout.write('Overwrite config? (y/n) '); setInterval(() => {}, 1000);"), f.cwd, {sessionId: session, activityId: 'a1', ownerId: 'techne'});
    const slow = await start(await f.script("console.log('epoch 1 of 90'); setInterval(() => {}, 1000);"), f.cwd, {sessionId: session, activityId: 'a1', ownerId: 'techne'});
    await waitFor(() => events.filter(event => event.kind === 'stall').length, count => count === 1, {label: 'stall event'});
    await new Promise(resolve => setTimeout(resolve, 1000));
    const stalls = events.filter(event => event.kind === 'stall');
    assert.equal(stalls.length, 1, 'once per job');
    assert.equal(stalls[0]!.job.id, stuck.id);
    assert.ok(!events.some(event => event.job.id === slow.id));
    const text = jobStalledNotice({id: stuck.id, command: stuck.command, starter: 'Techne', runMs: 1000, exitCode: undefined, tail: lastLines(stuck.tail), logPath: undefined, audience: 'director'});
    assert.match(text, /probably waiting for input/);
    assert.match(text, /stop: true/);
  } finally {Object.assign(backgroundTuning, saved); stop(); await f.cleanup(session);}
});

test('looksInteractive recognises prompts and not ordinary output', () => {
  for (const line of ['Proceed (y/n)', 'Install? [Y/n]', 'Are you sure (yes/no)', 'Press Enter to continue', 'Press any key', 'Continue?', 'Overwrite? ', 'Do you want to install the package?', 'Would you like to proceed?'])
    assert.equal(looksInteractive('output\n' + line), true, line);
  for (const line of ['epoch 3 of 90', 'Downloading... 40%', 'Why did this fail?', 'compiled successfully', ''])
    assert.equal(looksInteractive('output\n' + line), false, line);
});

test('a user Stop of the activity still kills its jobs, without a notice; other activities and sessions keep theirs', {timeout: 20_000}, async () => {
  const f = await fixture();
  const {events, stop} = collect('s-user');
  try {
    const sleeper = await f.script('setInterval(() => {}, 1000);');
    const a = await start(sleeper, f.cwd, {sessionId: 's-user', activityId: 'act-1', ownerId: 'techne', toolId: 'c1'});
    const b = await start(sleeper, f.cwd, {sessionId: 's-user', activityId: 'act-2', ownerId: 'kalon', toolId: 'c2'});
    const other = await start(sleeper, f.cwd, {sessionId: 's-other', activityId: 'act-1', ownerId: 'techne', toolId: 'c1'});
    assert.equal(killBackgroundJobs('act-1', 's-user'), 1);
    await waitFor(() => alive(a.pid), running => !running);
    assert.ok(alive(b.pid) && alive(other.pid));
    assert.equal(killBackgroundJobs(undefined, 's-user'), 1, 'session close kills what is left of the session');
    await waitFor(() => alive(b.pid), running => !running);
    assert.ok(alive(other.pid), 'another session is untouched');
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(events.length, 0, 'deliberate kills send no notice');
    assert.equal(stopBackgroundJob(other.id, 's-other')?.stopped, true);
  } finally {stop(); await f.cleanup('s-user', 's-other');}
});
