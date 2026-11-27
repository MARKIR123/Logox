/**
 * What one Anamnesis run does: read the session, ask the model once (no tools), and apply the answer.
 * A run changes nothing until the model has answered, so an aborted run leaves memory and watermarks as they were.
 */
import {promisify} from 'node:util';
import {execFile as execFileCb} from 'node:child_process';
import type {Journal} from '../store/journal.js';
import type {ModelTurn} from '../runtime/messages.js';
import type {MemoryRecord, MemoryStore} from './memory.js';
import type {ResolvedModel} from './model.js';
import {applyOperations, dreamDetail, dreamStage, parseDreamAnswer} from './operations.js';
import {harvestMessage, harvestRequest, memoryChanges, parseHarvestAnswer, type HarvestParts, type HarvestSource, type MemoryChange} from './harvest.js';
import {DIRECTOR_ID} from '../runtime/director-id.js';
import {DREAM_MAX_TOKENS, DREAM_SYSTEM_PROMPT, RECAP_MAX_TOKENS, RECAP_SYSTEM_PROMPT, RECORD_CONTENT_CAP} from './prompts.js';
import type {AnamnesisDriver, RunContext, RunKind, RunOutcome} from './service.js';
import {DREAM_TRANSCRIPT_CAP, RECAP_TRANSCRIPT_CAP, buildTranscript, hasNewMaterial, marksOf, type OwnerEntries} from './transcript.js';
import type {WatermarkStore} from './watermark.js';

const execFile = promisify(execFileCb);

/** Branch and the first uncommitted files, in a few lines; never throws. */
export async function getGitStatus(cwd: string): Promise<string> {
  try {
    const {stdout: branch} = await execFile('git', ['branch', '--show-current'], {cwd, timeout: 5000}).catch(() => ({stdout: ''}));
    const {stdout: status} = await execFile('git', ['status', '--porcelain'], {cwd, timeout: 5000}).catch(() => ({stdout: ''}));
    const branchName = branch.trim() || 'detached';
    const lines = status.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return `Branch ${branchName} (clean working tree)`;
    return `Branch ${branchName} (${lines.length} uncommitted changes):\n${lines.slice(0, 10).map(l => '  ' + l).join('\n')}${lines.length > 10 ? `\n  ... and ${lines.length - 10} more` : ''}`;
  } catch {
    return 'Git status unavailable';
  }
}

export interface RunnerDeps {
  sessionId: string;
  cwd: string;
  journal: Pick<Journal, 'load'>;
  /** Every owner with a journal in this session: the actor catalog plus the owners of the session's tasks. */
  owners(): Promise<readonly string[]>;
  memory: MemoryStore;
  watermarks: WatermarkStore;
  /** Resolved for each run, so a model chosen later is used at once. Throws the "no usable model" error. */
  model(): Promise<ResolvedModel>;
  /** Records the usage of one request under the owner `anamnesis`. */
  charge(usage: ModelTurn['usage'], identity: string): Promise<void> | void;
  /** Records the usage of one harvest fork on the Director's meter (category `harvest`). */
  chargeHarvest?(usage: ModelTurn['usage'], identity: string): Promise<void> | void;
  gitStatus?(cwd: string): Promise<string>;
  /** `YYYY-MM-DD` of today. */
  today?(): string;
}

export const recapMessage = (git: string, transcript: string) => 'Working tree:\n' + git + '\n\nConversation:\n' + transcript;
const recordBlock = (record: MemoryRecord) => '## ' + record.scope + '/' + record.name + ' (' + record.type + ')\n' + record.description + '\n' + record.content.slice(0, RECORD_CONTENT_CAP);
export const dreamMessage = (today: string, records: readonly MemoryRecord[], transcript: string) =>
  'Today: ' + today + '\n\nCurrent memory records:\n' + (records.length ? records.map(recordBlock).join('\n\n') : '(none)') + '\n\nUnreviewed transcript:\n' + transcript;
/** First line of a recap is the one-sentence summary (the card title); the rest is the card body. */
export function splitRecap(text: string): {stage: string; detail: string} {
  const lines = text.trim().split(/\r?\n/);
  const first = lines.findIndex(line => line.trim());
  if (first < 0) return {stage: '', detail: ''};
  return {stage: lines[first]!.trim().replace(/^⏵\s*/u, '').slice(0, 160), detail: lines.slice(first + 1).join('\n').trim().replace(/\n+(?=(?:Done|Open|Next):)/g, '\n\n')};
}

export class AnamnesisRunner implements AnamnesisDriver {
  constructor(private readonly deps: RunnerDeps) {}
  private async load(): Promise<OwnerEntries[]> {
    const ids = [...new Set(await this.deps.owners())];
    return Promise.all(ids.map(async ownerId => ({ownerId, entries: await this.deps.journal.load(this.deps.sessionId, ownerId)})));
  }
  async material(kind: RunKind): Promise<boolean> {
    return hasNewMaterial(await this.load(), await this.deps.watermarks.marks(kind));
  }
  run(context: RunContext): Promise<RunOutcome> {
    if (context.harvest) return this.harvest(context, context.harvest);
    return context.kind === 'recap' ? this.recap(context) : this.dream(context);
  }
  /**
   * The parts a harvest asks for now: each enabled part with something new to cover (recap: any journal beyond the recap marks; memory: the
   * Director's journal beyond its dream mark). Both false means there is nothing to harvest.
   */
  async harvestParts(enabled: HarvestParts): Promise<HarvestParts> {
    const owners = await this.load(), director = owners.filter(owner => owner.ownerId === DIRECTOR_ID);
    return {recap: enabled.recap && hasNewMaterial(owners, await this.deps.watermarks.marks('recap')),
      memory: enabled.memory && hasNewMaterial(director, await this.deps.watermarks.marks('dream'))};
  }
  /**
   * Forks the Director's last request (`harvest.ts:harvestRequest()`), reads the recap and the memory operations out of the one answer and applies them
   * only after it arrived: an abort or an unreadable answer leaves memory and the watermarks alone. Tool calls are never run.
   */
  private async harvest(context: RunContext, source: HarvestSource): Promise<RunOutcome> {
    const {parts} = source, owners = await this.load();
    const records = parts.memory ? await this.deps.memory.list() : [];
    const git = parts.recap ? await (this.deps.gitStatus ?? getGitStatus)(this.deps.cwd) : '';
    const today = this.deps.today?.() ?? new Date().toISOString().slice(0, 10);
    context.signal.throwIfAborted();
    const turn = await source.provider.respond(harvestRequest(source, harvestMessage(parts, {today, git, records, recordCap: RECORD_CONTENT_CAP})), () => {}, context.signal);
    await this.deps.chargeHarvest?.(turn.usage, source.model);
    const answer = parseHarvestAnswer(turn.message.text, parts);
    if (!answer) throw new Error('Anamnesis could not read the harvest answer; this part of the session will be reviewed again.');
    // The model has answered: from here the run finishes without yielding to an abort, so a harvest never half-applies.
    context.signal.throwIfAborted();
    const note = answer.recap ? splitRecap(answer.recap) : undefined;
    let changes: MemoryChange[] = [], dream: Awaited<ReturnType<typeof applyOperations>> | undefined;
    if (answer.memory) {
      dream = await applyOperations(this.deps.memory, answer.memory);
      changes = memoryChanges(records, await this.deps.memory.list(), dream);
    }
    if (note?.stage) await this.deps.watermarks.save('recap', marksOf(owners));
    if (answer.memory) await this.deps.watermarks.merge('dream', marksOf(owners.filter(owner => owner.ownerId === DIRECTOR_ID)));
    const report = {at: Date.now(), recap: Boolean(note?.stage), changes};
    const memoryText = dream ? dreamDetail(dream) : '';
    if (note?.stage) return {...note, detail: [note.detail, memoryText].filter(Boolean).join('\n\n'), harvest: report};
    return {stage: dream ? dreamStage(dream) : 'Nothing new to remember', detail: memoryText, empty: !changes.length, harvest: report};
  }
  /** One plain request: the system prompt, one user message, no tools. Thinking stays off unless the chosen model carries an effort of its own. */
  private async ask(system: string, text: string, maxTokens: number, signal: AbortSignal): Promise<string> {
    const model = await this.deps.model();
    signal.throwIfAborted();
    const turn = await model.respond.respond({system, messages: [{role: 'user', text}], tools: [], maxTokens, ...(model.effort ? {} : {thinking: false as const})}, () => {}, signal);
    await this.deps.charge(turn.usage, model.identity);
    return turn.message.text;
  }
  private async recap(context: RunContext): Promise<RunOutcome> {
    const owners = await this.load();
    context.signal.throwIfAborted();
    const transcript = buildTranscript(owners, {}, RECAP_TRANSCRIPT_CAP);
    if (!transcript) return {stage: 'Nothing to recap yet', detail: ''};
    const git = await (this.deps.gitStatus ?? getGitStatus)(this.deps.cwd);
    context.signal.throwIfAborted();
    const note = splitRecap(await this.ask(RECAP_SYSTEM_PROMPT, recapMessage(git, transcript), RECAP_MAX_TOKENS, context.signal));
    if (!note.stage) throw new Error('Anamnesis received an empty note.');
    await this.deps.watermarks.save('recap', marksOf(owners));
    return note;
  }
  private async dream(context: RunContext): Promise<RunOutcome> {
    const owners = await this.load();
    const transcript = buildTranscript(owners, await this.deps.watermarks.marks('dream'), DREAM_TRANSCRIPT_CAP);
    context.signal.throwIfAborted();
    if (!transcript) {
      await this.deps.watermarks.save('dream', marksOf(owners));
      return {stage: dreamStage({saved: [], deleted: []}), detail: '', empty: true};
    }
    const records = await this.deps.memory.list();
    const today = this.deps.today?.() ?? new Date().toISOString().slice(0, 10);
    const operations = parseDreamAnswer(await this.ask(DREAM_SYSTEM_PROMPT, dreamMessage(today, records, transcript), DREAM_MAX_TOKENS, context.signal));
    if (!operations) throw new Error('Anamnesis could not read the dream answer; this part of the session will be reviewed again.');
    // The model has answered: from here the run finishes without yielding to an abort, so a dream never half-applies.
    context.signal.throwIfAborted();
    const result = await applyOperations(this.deps.memory, operations);
    await this.deps.watermarks.save('dream', marksOf(owners));
    return {stage: dreamStage(result), detail: dreamDetail(result), empty: !result.saved.length && !result.deleted.length};
  }
}
