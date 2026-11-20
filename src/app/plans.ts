/**
 * Wires the session's plan board (`src/store/plans.ts`): the work records nodes link to are the delegation projection of the runtime snapshot
 * (`src/runtime/delegations.ts`), and the evidence for an `accept` without evidence is read from the ledger of the node's finished work (changed files,
 * commands with exit codes) or from an Automa job's own `Finish` fields. Nothing is stored here.
 */
import {isAbsolute, relative, sep} from 'node:path';
import type {ActorCatalog} from '../actors/catalog.js';
import {ledgerFacts} from '../context/round-memory.js';
import {projectDelegations} from '../runtime/delegations.js';
import type {PlanNode} from '../runtime/plan.js';
import type {RuntimeStore} from '../runtime/store.js';
import {storedMessage, type Journal} from '../store/journal.js';
import {PlanBoard} from '../store/plans.js';

export interface PlansDeps {
  session: string; cwd: string; store: RuntimeStore; journal: Journal; actors: ActorCatalog;
  notice(text: string): void;
}

const MAX_COMMANDS = 5, MAX_FILES = 12;

export function createPlans(deps: PlansDeps): PlanBoard {
  const {session, cwd, store, journal, actors} = deps;
  const shown = (path: string) => {
    const inside = isAbsolute(path) ? relative(cwd, path) : path;
    return (inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path).split(sep).join('/');
  };
  const name = (ownerId: string) => actors.find(ownerId)?.name ?? ownerId;
  return new PlanBoard({
    cwd, sessionId: session, notice: deps.notice,
    work: () => projectDelegations({snapshot: store.getSnapshot(), sessionId: session}),
    workRevision: () => store.getSnapshot().revision,
    knownOwners: () => actors.list().map(actor => actor.id),
    evidence: async (node: PlanNode) => {
      const records = projectDelegations({snapshot: store.getSnapshot(), sessionId: session});
      const lines: string[] = [];
      for (const link of node.links) {
        const record = records.find(item => item.id === (link.activityId ?? link.automaJob));
        // Only finished, completed work is evidence: a task still running or one that failed proves nothing.
        if (!record || record.status !== 'completed' && record.status !== 'done') continue;
        const before = lines.length;
        if (link.activityId) {
          const entries = (await journal.load(session, record.ownerId)).filter(entry => entry.activityId === record.id).map(storedMessage);
          const {files, commands} = ledgerFacts(entries);
          if (files.length) lines.push(`Changed by ${name(record.ownerId)}: ${files.slice(0, MAX_FILES).map(shown).join(', ')}${files.length > MAX_FILES ? `, ${files.length - MAX_FILES} more` : ''}`);
          for (const command of commands.slice(-MAX_COMMANDS)) lines.push(`Ran: ${command.text} (exit ${command.exit})`);
        } else for (const item of record.result?.evidence ?? []) lines.push(`${record.jobId ?? 'Automa job'}: ${item}`);
        if (lines.length === before && record.result?.summary) lines.push(`Reported by ${record.kind === 'automa' ? 'Automa job ' + (record.jobId ?? '') : name(record.ownerId)}: ${record.result.summary}`);
      }
      return lines;
    },
  });
}
