import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {RuntimeStore} from './runtime/store.js';
import {Ensemble, type ActorId, type ActorExecutor} from './actors/ensemble.js';
import {Anamnesis} from './anamnesis/service.js';
import {Journal} from './store/journal.js';
import {portfolioStyleLabels, type PortfolioActivities} from './demo/portfolio.js';

const actorReplies = {
  logox: 'Noted. The pending role cards are still in place; expand one any time to decide.',
  aletheia: '（notes the extra scope）\nRecorded. I will check the related call chains and attach exact path:line coordinates.',
  techne: '（notes the constraint）\nGot it. This boundary is folded into the current edit queue and will be delivered together once tests pass.',
  kalon: '（notes the color requirements, leaves the source alone）\nOkay, no file changes yet. The main colors go to soft charcoal and warm white, with the accent reserved for work titles. I will start once you sign off.',
};

export function createDemo(sessionId: string, cwd: string) {
  const store = new RuntimeStore();
  let scenario: PortfolioActivities;
  const executor: ActorExecutor = async (prompt, context) => {
    context.report('Structure survey', 'Checking the page component tree and style breakpoints...');
    if (context.activityId === scenario.techne) {
      const allowed = await context.permission({
        kind: 'permission', title: 'Allow edits to these two files?', tool: 'edit',
        arguments: {files: ['src/pages/index.tsx:18-34', 'src/styles/home.css:96-112']},
        reason: 'Update the hero layout structure and component alignment rules on the homepage',
      });
      context.say(allowed ? 'Plan approved; reworking the hero structure with the new hierarchy now.' : 'Understood, leaving things as they are. Call me any time you want adjustments.');
      return;
    }
    if (context.activityId === scenario.kalon) {
      const outcome = await context.ask({
        kind: 'question', title: 'Homepage mood', questions: [{id: 'style', header: 'Mood',
          question: 'Which mood should the homepage lean toward?', options: [
            {id: 'minimal', label: portfolioStyleLabels.minimal, description: 'Let projects and writing take center stage, with minimal decoration.'},
            {id: 'editorial', label: portfolioStyleLabels.editorial, description: 'Soft colors and a layout that invites reading.'},
          ]}],
      });
      context.signal.throwIfAborted();
      context.say(outcome.status === 'answered' ? 'Got it, the layout style is set. I will steer the overall tone and whitespace rhythm accordingly.' : 'Preference selection cancelled; keeping the default layout for now.');
      return;
    }
    context.say(actorReplies[context.ownerId]);
    await delay(180, undefined, {signal: context.signal});
    if (prompt.includes('/ask')) {
      const outcome = await context.ask({
        kind: 'question', title: 'Confirm direction', questions: [
          {id: 'focus', header: 'Focus', question: 'Which part should I polish first?', options: [
            {id: 'stage', label: 'Stage interaction and whitespace', description: 'Polish cards, component spacing and the input experience first.'},
            {id: 'memory', label: 'Role memory and ledger', description: 'Check independent context and recovery first.'},
          ]},
          {id: 'detail', header: 'Extras', question: 'Are there any specific aesthetic or structural requirements?'},
        ],
      });
      context.signal.throwIfAborted();
      context.say(outcome.status === 'answered' ? 'Answer received: ' + JSON.stringify(outcome.response) : 'This question was cancelled.');
    }
    if (prompt.includes('/permission')) {
      const allowed = await context.permission({kind: 'permission', title: 'Tool execution permission', tool: 'write',
        arguments: {path: 'example.txt', content: 'Demo content'}, reason: 'Write the sample config and style variables file'});
      context.say(allowed ? 'Write permission granted; generating the target file.' : 'Permission not granted; write cancelled.');
    }
    context.report('Wrap-up', 'All role tasks are done and status is synced.');
  };
  const ensemble = new Ensemble(sessionId, store, new Journal(join(cwd, '.logox', 'demo', 'actors')), executor);
  const aletheia = randomUUID();
  store.activities.create({sessionId, activityId: aletheia, ownerId: 'aletheia', kind: 'actor',
    title: 'Survey homepage structure and pinpoint problem locations', status: 'completed', stage: 'Sample result', detail: 'Hero component tree and visual structure survey complete and ready.'});
  const techne = ensemble.dispatch('techne', 'Adjust hero hierarchy and project layout');
  const kalon = ensemble.dispatch('kalon', 'Tune homepage typography, color and whitespace');
  scenario = {aletheia, techne: techne.activityId, kalon: kalon.activityId};
  const ready = new Promise<void>(resolve => {
    const unsubscribe = store.subscribe(() => {
      if (store.getSnapshot().interactions.some(request => request.activityId === scenario.techne) ||
          store.getSnapshot().activities.some(activity => activity.activityId === scenario.techne && ['failed', 'cancelled'].includes(activity.status))) {
        unsubscribe(); resolve();
      }
    });
  });
  const dream = new Anamnesis(sessionId, store, async context => {
    for (const stage of ['Review materials', 'Research topics', 'Verify candidates']) {
      context.report(stage, 'Lifecycle demo: no project materials were read and no memory was committed.');
      await delay(900, undefined, {signal: context.signal});
    }
  }, () => ensemble.isBusy());
  const submit = async (text: string, source: ActorId = 'logox') => {
    const raw = text.trim();
    if (!raw) return;
    if (raw === '/anamnesis stop') {await dream.pause(); return;}
    if (raw === '/anamnesis start') {dream.start(); return;}
    const match = /^@(logox|aletheia|techne|kalon)\s+([\s\S]+)$/i.exec(raw);
    if (raw.startsWith('@') && !match) throw new Error('Enter a known role and task, for example @kalon take a look at the homepage colors');
    await dream.foregroundSubmitted();
    if (raw.startsWith('/cast ')) {
      const handles = ensemble.dispatchBatch(['aletheia', 'techne', 'kalon'].map(ownerId => ({ownerId: ownerId as ActorId, prompt: raw.slice(6)})));
      for (const handle of handles) void handle.done.finally(() => dream.foregroundFinished());
      return;
    }
    const ownerId = match ? match[1]!.toLowerCase() as ActorId : source;
    const handle = ensemble.dispatch(ownerId, match?.[2] ?? raw, source);
    void handle.done.finally(() => dream.foregroundFinished());
  };
  const close = async () => {
    store.interactions.close();
    await Promise.all([ensemble.close(), dream.close()]);
  };
  return {store, scenario, ready, submit, close, noteDraft: () => dream.noteDraft(), cancel: (activityId: string) => {ensemble.cancel(activityId);}};
}
