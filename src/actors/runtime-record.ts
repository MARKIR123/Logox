import {isAbsolute, relative, sep} from 'node:path';
import {ledgerFacts, ROUND_MARKERS} from '../context/round-memory.js';
import type {ModelMessage} from '../runtime/messages.js';
import {RUNTIME_RECORD_LABELS as LABEL} from '../prompts/runtime/director.js';
import {ownsPath} from '../tools/ownership.js';

const MAX_FILES = 20, MAX_COMMANDS = 5;

export interface RuntimeRecordInput {
  actor: string;
  /** The activity's ledger messages. */
  messages: readonly ModelMessage[];
  ownedFiles?: readonly string[] | undefined;
  acceptance?: readonly string[] | undefined;
  /** The leading bracket marker of a runtime-written round summary; absent when the model closed the round. */
  marker?: string | undefined;
  /** Whether a round record exists for the activity, so the closing line can be stated. */
  roundKnown?: boolean | undefined;
  cwd: string;
}

const closer: Record<string, string> = {
  [ROUND_MARKERS.completed]: 'the runtime ([runtime])',
  [ROUND_MARKERS.failed]: 'the runtime ([failed])',
  [ROUND_MARKERS.cancelled]: 'the runtime ([interrupted])',
  [ROUND_MARKERS.reply]: 'the runtime ([reply])',
};

function shown(path: string, cwd: string): string {
  const slashed = (text: string) => text.split(sep).join('/');
  if (!isAbsolute(path)) return slashed(path);
  const rel = relative(cwd, path);
  return slashed(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path);
}

/** The runtime's own account of an activity, built from its ledger alone (no model call, no disk diff). */
export function buildRuntimeRecord(input: RuntimeRecordInput): string {
  const {files, commands} = ledgerFacts(input.messages);
  const names = files.map(file => shown(file, input.cwd));
  const lines = [LABEL.header(input.actor),
    LABEL.changed + (names.length ? names.slice(0, MAX_FILES).join(', ') + (names.length > MAX_FILES ? `, ... ${names.length - MAX_FILES} more` : '') : LABEL.none)];
  if (input.ownedFiles?.length) {
    const outside = files.filter(file => !ownsPath(input.ownedFiles!, file, input.cwd)).map(file => shown(file, input.cwd));
    if (outside.length) lines.push(LABEL.outside + outside.slice(0, MAX_FILES).join(', ') + (outside.length > MAX_FILES ? `, ... ${outside.length - MAX_FILES} more` : ''));
  }
  const last = commands.slice(-MAX_COMMANDS);
  lines.push(LABEL.commands + (last.length ? last.map(command => `"${command.text}" exit ${command.exit}`).join('; ') : LABEL.none));
  if (input.roundKnown) lines.push(LABEL.closedBy + (input.marker ? closer[input.marker] ?? 'the runtime' : 'the model'));
  if (input.acceptance?.length) lines.push(LABEL.acceptance, ...input.acceptance.map(item => '- ' + item.replace(/\s+/g, ' ')));
  return lines.join('\n');
}
