import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Box, Text, render, renderToString, useApp, useCursor, useInput, usePaste, useStdout, useWindowSize, type DOMElement} from 'ink';
import {writeFile} from 'node:fs/promises';
import stringWidth from 'string-width';
import {palette} from '../appearance/theme.js';
import {clipLine} from '../terminal/text.js';
import {useContentHeight} from '../terminal/metrics.js';
import {QuestionPanel, type PanelQuestion, type QuestionSelection} from '../interactions/question-panel.js';
import {readQuestionClipboard} from '../terminal/clipboard.js';
import {runProviderPreview, type PreviewProviderChange} from './provider-wizard-preview.js';

export const sampleQuestions: readonly PanelQuestion[] = [
  {header: 'Approach', question: 'Which implementation approach should we use?',
    detail: 'Select an option, or type a note directly to attach it to your choice.',
    options: [{label: 'Keep the existing interface', description: 'Preserve the accepted layout and interactions'},
      {label: 'Explore an alternative', description: 'Keep this as an isolated prototype'}]},
  {header: 'Checks', question: 'Which checks should be included?', multiSelect: true, defaultSelected: ['UI tests'],
    options: [{label: 'UI tests', description: 'Verify the real Ink output'}, {label: 'Keyboard and mouse', description: 'Check navigation, editing and focus'},
      {label: 'Narrow terminal', description: 'Keep the focused row and input visible'}]},
  {header: 'Notes', question: 'Anything else we should preserve?', detail: 'Your chat draft remains intact while answering or navigating questions.'},
];
export const secretSample: PanelQuestion = {header: 'Providers', question: 'Enter the API key', secret: true,
  detail: 'Preview only — use fake text. Nothing is saved or sent.'};

interface Snapshot {
  readonly key: string; readonly question: PanelQuestion; readonly position: number; readonly total: number; readonly answered: number;
  readonly draft?: QuestionSelection; readonly canBack: boolean; readonly canForward: boolean;
}
/** In-memory preview host only. It never enters RuntimeStore, journals or model context. */
export class PreviewQuestions {
  private listeners = new Set<() => void>();
  private snapshot: Snapshot | null = null;
  private sequence = 0;
  private batch: {questions: readonly PanelQuestion[]; index: number; answers: (QuestionSelection | undefined)[];
    drafts: (QuestionSelection | undefined)[]; resolve: (result: readonly QuestionSelection[] | null) => void} | null = null;
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  getSnapshot = () => this.snapshot;
  private refresh() {
    const batch = this.batch;
    this.snapshot = batch ? {key: `${this.sequence}:${batch.index}`, question: batch.questions[batch.index]!, position: batch.index + 1,
      total: batch.questions.length, answered: batch.answers.filter(Boolean).length,
      ...(batch.drafts[batch.index] ? {draft: batch.drafts[batch.index]!} : {}), canBack: batch.index > 0, canForward: batch.index + 1 < batch.questions.length} : null;
    for (const listener of this.listeners) listener();
  }
  ask = (questions: readonly PanelQuestion[]): Promise<readonly QuestionSelection[] | null> => {
    if (this.batch) throw new Error('A preview question is already active');
    if (!questions.length) return Promise.resolve([]);
    return new Promise(resolve => {
      this.sequence++; this.batch = {questions, index: 0, answers: [], drafts: [], resolve}; this.refresh();
    });
  };
  answer = (selection: QuestionSelection) => {
    const batch = this.batch; if (!batch) return;
    batch.answers[batch.index] = selection; batch.drafts[batch.index] = selection;
    const next = batch.questions.findIndex((_question, index) => !batch.answers[index]);
    if (next < 0) {this.batch = null; this.refresh(); batch.resolve(batch.answers as QuestionSelection[]);}
    else {batch.index = next; this.refresh();}
  };
  navigate = (direction: -1 | 1, draft: QuestionSelection) => {
    const batch = this.batch; if (!batch) return;
    const next = batch.index + direction;
    if (next < 0 || next >= batch.questions.length) return;
    const committed = batch.answers[batch.index];
    if (committed && (committed.custom !== draft.custom || committed.selected.length !== draft.selected.length
      || committed.selected.some((label, index) => label !== draft.selected[index]))) batch.answers[batch.index] = undefined;
    batch.drafts[batch.index] = draft; batch.index = next; this.refresh();
  };
  cancel = () => {
    const batch = this.batch; if (!batch) return;
    this.batch = null; this.refresh(); batch.resolve(null);
  };
  close = () => {this.cancel(); this.listeners.clear();};
}

function ChatCaret({x, y}: {x: number; y: number}) {
  const {setCursorPosition} = useCursor(); setCursorPosition({x, y}); return null;
}

export function QuestionShowcase({mode = 'questions', clipboard = readQuestionClipboard}: {
  mode?: 'questions' | 'login'; clipboard?: () => Promise<string | null>;
}) {
  const [session] = useState(() => new PreviewQuestions());
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [collapsed, setCollapsed] = useState(false), [notice, setNotice] = useState(''), [chatDraft, setChatDraft] = useState('Keep this chat draft');
  const [busy, setBusy] = useState(true);
  const chatRef = useRef(chatDraft), live = useRef(true), busyRef = useRef(true), foldedRef = useRef(collapsed);
  const toggleFold = () => {foldedRef.current = !foldedRef.current; setCollapsed(foldedRef.current);};
  const {columns, rows} = useWindowSize(), {stdout} = useStdout(), {exit} = useApp();
  const width = Math.max(1, columns - 1), mainVisible = rows >= 3 && ((!snapshot && !busy) || collapsed);
  const panelRef = useRef<DOMElement>(null), panelHeight = useContentHeight(panelRef);
  const panelBudget = Math.max(1, rows - (rows >= 3 ? 2 : 0) - (mainVisible ? 1 : 0));
  const panelY = Math.max(0, rows - 1 - (mainVisible ? 1 : 0) - panelHeight);
  const changes = useRef<PreviewProviderChange[]>([]);
  useEffect(() => {
    live.current = true;
    stdout.write('\x1b[?1000h\x1b[?1006h');
    const start = async () => {
      if (mode === 'login') await runProviderPreview({ask: session.ask, commit: change => {changes.current.push(change);}});
      else await session.ask(sampleQuestions);
      if (live.current) {busyRef.current = false; setBusy(false); foldedRef.current = false; setCollapsed(false); setNotice(`Preview ended · ${changes.current.length} simulated provider changes · nothing saved`);}
    };
    void start();
    return () => {live.current = false; session.close(); stdout.write('\x1b[?1000l\x1b[?1006l');};
  }, [session, mode, stdout]);
  usePaste(text => {
    if (rows >= 3 && ((!session.getSnapshot() && !busyRef.current) || foldedRef.current)) {
      chatRef.current += text.replace(/[\r\n\t]+/g, ' '); setChatDraft(chatRef.current);
    }
  });
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'd') {exit(); return;}
    const activeQuestion = session.getSnapshot();
    const chatActive = (!activeQuestion && !busyRef.current) || foldedRef.current;
    if (rows < 3 || !chatActive || (activeQuestion && ((key.ctrl && (input === 'k' || input === 'c')) || key.escape))) return;
    if (key.ctrl && input === 'c') {exit(); return;}
    if (key.return) {setNotice('Chat draft kept locally — no agent was called.'); return;}
    if (key.backspace || key.delete) chatRef.current = [...chatRef.current].slice(0, -1).join('');
    else if (!key.ctrl && !key.meta && input && !input.includes('\x1b')) chatRef.current += input.replace(/[\r\n]/g, ' ');
    setChatDraft(chatRef.current);
  });
  return <Box width={width} height={rows} flexDirection="column" overflow="hidden">
    <Box flexGrow={1} flexShrink={1} flexDirection="column" overflow="hidden">
      <Text color={palette.fg} wrap="truncate">Logox · {mode === 'login' ? '/login' : 'Question panel'} preview</Text>
      <Text color={palette.muted} wrap="truncate">{notice || 'Isolated fixtures · no network, auth files, browser or persistent changes'}</Text>
      {collapsed && <Text color={palette.muted} wrap="truncate">Question parked · chat input active · Ctrl+K returns to the answer</Text>}
    </Box>
    {snapshot && <Box ref={panelRef} flexDirection="column" flexShrink={0}>
      <QuestionPanel key={snapshot.key} question={snapshot.question} position={snapshot.position} total={snapshot.total} answered={snapshot.answered}
        width={width} height={panelBudget} y={panelY} collapsed={collapsed} onToggleFold={toggleFold}
        {...(snapshot.draft ? {initialDraft: snapshot.draft} : {})}
        onAnswer={session.answer} onCancel={session.cancel}
        onBack={snapshot.canBack ? draft => session.navigate(-1, draft) : undefined}
        onForward={snapshot.canForward ? draft => session.navigate(1, draft) : undefined} readClipboard={clipboard}/>
    </Box>}
    {mainVisible && <ChatCaret x={Math.min(width - 1, stringWidth(chatDraft))} y={rows - 2}/>}
    {mainVisible && <Box height={1} flexShrink={0}><Text color={palette.fg} wrap="truncate">{clipLine(chatDraft, width)}</Text></Box>}
    {rows >= 3 && <Box height={1} flexShrink={0}><Text color={palette.muted} wrap="truncate">Ctrl+D Exit · Preview only{snapshot && collapsed ? ' · Ctrl+K Expand question' : ''}</Text></Box>}
  </Box>;
}

export async function runQuestionPreview(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const get = (name: string, fallback: string) => {const at = args.indexOf(name); return at >= 0 ? args[at + 1] ?? fallback : fallback;};
  const scene = get('--scene', 'questions');
  if (args.includes('--static') || args.includes('--snapshot')) {
    const width = Math.max(12, Number(get('--width', '80')) || 80), height = Math.max(6, Number(get('--height', '18')) || 18);
    const questionIndex = scene === 'multi' ? 1 : scene === 'notes' ? 2 : 0;
    const question = scene === 'secret' ? secretSample : scene === 'login'
      ? {header: 'Providers', question: 'What do you want to do?', hideCustomInput: true, options: [
        {label: 'Add a new provider', description: 'Built-in catalog or a custom API endpoint'},
        {label: 'Edit an existing provider', description: 'Change the key, endpoint, protocol, or models — or delete the provider'},
      ]} : sampleQuestions[questionIndex]!;
    const output = renderToString(<QuestionPanel question={question} width={width} height={height} position={questionIndex + 1}
      total={scene === 'login' || scene === 'secret' ? 1 : 3} answered={questionIndex}
      {...(scene === 'secret' ? {initialDraft: {selected: [], custom: 'fake-key-preview'}} : {})}
      collapsed={args.includes('--folded')} onToggleFold={() => {}} onAnswer={() => {}} onCancel={() => {}}/>, {columns: width});
    if (args.includes('--snapshot')) await writeFile(get('--snapshot', ''), output, 'utf8');
    else process.stdout.write(output + '\n');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive preview requires a terminal. Use --static instead.');
  const instance = render(<QuestionShowcase mode={scene === 'login' ? 'login' : 'questions'}/>, {alternateScreen: true, patchConsole: false, exitOnCtrlC: false});
  await instance.waitUntilExit();
}
