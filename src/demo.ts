import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {RuntimeStore} from './runtime/store.js';
import {Ensemble, type ActorId, type ActorExecutor} from './actors/ensemble.js';
import {Anamnesis} from './anamnesis/service.js';
import {Journal} from './store/journal.js';
import {portfolioStyleLabels, type PortfolioActivities} from './demo/portfolio.js';

const actorReplies = {
  logox: '补充已记下。待处理的角色卡片仍在原位，随时可以展开裁决。',
  aletheia: '（记下补充范围）\n已记录。我会核对相关调用链并附上精确的 path:line 坐标。',
  techne: '（记下约束条件）\n收到。这处边界已并入当前修改队列，测试通过后一并交差。',
  kalon: '（记下配色要求，暂不改动源码）\n行，先不动文件。主色收进柔和的暗灰与暖白，强调色只留给作品标题——等你和先生点头了再落笔。',
};

export function createDemo(sessionId: string, cwd: string) {
  const store = new RuntimeStore();
  let scenario: PortfolioActivities;
  const executor: ActorExecutor = async (prompt, context) => {
    context.report('观察任务', '脚本演示：未调用模型或执行文件工具。');
    if (context.activityId === scenario.techne) {
      const allowed = await context.permission({
        kind: 'permission', title: '允许修改这两个文件吗？', tool: 'edit',
        arguments: {files: ['src/pages/index.tsx:18-34', 'src/styles/home.css:96-112']},
        reason: '演示首屏布局与留白审批；本入口仅展示方案，不实际修改文件。',
      });
      context.say(allowed ? '已允许本次演示方案；尚未执行文件修改。' : '未获得许可，保留建议，不修改文件。');
      return;
    }
    if (context.activityId === scenario.kalon) {
      const outcome = await context.ask({
        kind: 'question', title: '首页气质', questions: [{id: 'style', header: '首页气质',
          question: '你希望首页更接近哪种气质？', options: [
            {id: 'minimal', label: portfolioStyleLabels.minimal, description: '让项目和文字成为重点，装饰少一点。'},
            {id: 'editorial', label: portfolioStyleLabels.editorial, description: '用柔和的配色和有阅读感的版式。'},
          ]}],
      });
      context.signal.throwIfAborted();
      context.say(outcome.status === 'answered' ? '偏好已记下，整理为待核验候选；尚未修改页面或提交长期记忆。' : '本次偏好提问已取消。');
      return;
    }
    context.say(actorReplies[context.ownerId]);
    await delay(180, undefined, {signal: context.signal});
    if (prompt.includes('/ask')) {
      const outcome = await context.ask({
        kind: 'question', title: '确认方向', questions: [
          {id: 'focus', header: '本轮重点', question: '你希望我先打磨哪一部分？', options: [
            {id: 'stage', label: '舞台交互与留白', description: '先打磨卡片、组件间距与输入体验。'},
            {id: 'memory', label: '角色记忆与账本', description: '先检查独立上下文与恢复。'},
          ]},
          {id: 'detail', header: '补充要求', question: '还有哪些具体审美或结构要求？'},
        ],
      });
      context.signal.throwIfAborted();
      context.say(outcome.status === 'answered' ? '收到回答：' + JSON.stringify(outcome.response) : '这次提问已取消。');
    }
    if (prompt.includes('/permission')) {
      const allowed = await context.permission({kind: 'permission', title: '工具执行许可', tool: 'write',
        arguments: {path: 'example.txt', content: '演示内容'}, reason: '演示一次写入审批；不会实际写入文件。'});
      context.say(allowed ? '许可通过；演示未执行文件写入。' : '未获得许可，不做写入。');
    }
    context.report('整理结果', '对白与任务状态来自同一运行时。');
  };
  const ensemble = new Ensemble(sessionId, store, new Journal(join(cwd, '.logox', 'demo', 'actors')), executor);
  const aletheia = randomUUID();
  store.activities.create({sessionId, activityId: aletheia, ownerId: 'aletheia', kind: 'actor',
    title: '勘察首页结构与问题坐标', status: 'completed', stage: '示例成果', detail: '预置的作品集场景，未实际读取文件。'});
  const techne = ensemble.dispatch('techne', '调整首屏层级与项目排列');
  const kalon = ensemble.dispatch('kalon', '校准首页的字体、颜色和留白');
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
    for (const stage of ['回顾资料', '研究事项', '核验候选']) {
      context.report(stage, '生命周期演示：没有读取项目资料或提交记忆。');
      await delay(900, undefined, {signal: context.signal});
    }
  }, () => ensemble.isBusy());
  const submit = async (text: string, source: ActorId = 'logox') => {
    const raw = text.trim();
    if (!raw) return;
    if (raw === '/anamnesis stop') {await dream.pause(); return;}
    if (raw === '/anamnesis start') {dream.start(); return;}
    const match = /^@(logox|aletheia|techne|kalon)\s+([\s\S]+)$/i.exec(raw);
    if (raw.startsWith('@') && !match) throw new Error('请输入已知角色及任务，例如 @kalon 看一下首页配色');
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
