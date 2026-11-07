import {relative, resolve} from 'node:path';
import {shellWords} from '../../../permissions/shell.js';
import {ownsPath, patternsOverlap} from '../../ownership.js';
import {canonicalPath, within} from './paths.js';
import {chooseStyle, type AutomaProfile} from './preset.js';

/**
 * What one job may do beyond the baseline (read whatever the dispatcher can read, run commands the permission engine allows,
 * write the dispatcher's own scratchpad): the workspace paths it may edit. It only narrows; the permission engine still judges every call.
 */
export interface JobGrant {
  /** Workspace-relative paths or globs the job may edit. */
  readonly writes: readonly string[];
  /** Command prefixes that run one at a time across jobs (shared build artifacts). */
  readonly exclusive: readonly string[];
}

const TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'Edit', 'Write', 'Shell'] as const;

export function grantTools(_grant: JobGrant): readonly string[] {
  return TOOLS;
}

function matchesCommand(prefix: string, command: string): boolean {
  const parsed = shellWords(command);
  if (parsed.compound || parsed.dynamic) return false;
  return shellWords(prefix).words.every((word, index) => word.toLowerCase() === parsed.words[index]?.toLowerCase());
}

export function isExclusiveCommand(grant: JobGrant, command: string): boolean {
  return grant.exclusive.some(prefix => matchesCommand(prefix, command));
}

export interface GrantPath {
  /** The requested path (absolute) and the same path after resolving links. */
  readonly lexical: string;
  readonly canonical: string;
  /** The workspace root. */
  readonly root: string;
  /** The dispatcher's own scratchpad subdirectory: the one place outside `writes` where a worker may write. */
  readonly scratch?: string;
}

/** Only workspace writes are scoped: reads and commands go to the permission engine under the dispatcher's name. */
export function pathDenial(tool: string, grant: JobGrant, path: GrantPath): string | undefined {
  if (tool !== 'Edit' && tool !== 'Write') return undefined;
  // Every spelling is canonicalised (links, 8.3 names, case, slashes) before it is compared with a scope.
  const forms = [path.lexical, path.canonical].map(item => canonicalPath(item));
  if (path.scratch && forms.every(form => within(path.scratch!, form))) return undefined;
  const root = canonicalPath(path.root);
  if (forms.every(form => within(root, form) && ownsPath(grant.writes, form, root))) return undefined;
  const scratchHint = path.scratch ? ` Scratch scripts and notes go in your scratchpad ${path.scratch}.` : '';
  return `Not written: ${path.lexical} is outside this job's writes (${grant.writes.length ? grant.writes.join(', ') : 'none: a read-only job'}).${scratchHint} Report the change under "Not verified" instead of making it.`;
}

export interface AutomaJobArgs {
  readonly title?: string | undefined;
  readonly brief: string;
  /** Workspace paths or globs this job may edit; absent means read-only. */
  readonly writes?: readonly string[] | undefined;
  /** Keep this worker's context after the job so a later job can continue it. */
  readonly keep?: boolean | undefined;
  /** Id of a live kept worker to continue; anything else is ignored with a note. */
  readonly continue?: string | undefined;
}

export interface RetainedGrant {
  readonly id: string;
  readonly grant: JobGrant;
  readonly system: string;
}

export interface PlannedJob {
  readonly job: AutomaJobArgs & {readonly title: string};
  readonly grant: JobGrant;
  readonly model?: string | undefined;
  /** The worker's full system prompt (base contract plus style flavour). */
  readonly system: string;
  readonly denial?: string | undefined;
}

export const AUTOMA_MAX_RETAINED = 2;

const WORKSPACE_WIDE = /^(?:\.\/?|\*+|\*\*\/\*+|\.\/\*+|\.\/\*\*\/\*+|\/)$/;

export function titleFrom(brief: string): string {
  const line = brief.trim().split(/\r?\n/)[0]!.replace(/\s+/g, ' ');
  return line.length <= 60 ? line : line.slice(0, 59).trimEnd() + '…';
}

type Normalized = {kind: 'write'; pattern: string} | {kind: 'scratch'} | {kind: 'outside'} | {kind: 'wide'};

/** One `writes` entry as a workspace-relative pattern; any spelling of a path inside the dispatcher's scratchpad counts as scratch. */
export function normalizeWrite(entry: string, cwd: string, scratch: string | undefined): Normalized {
  const text = entry.trim().replaceAll('\\', '/');
  if (WORKSPACE_WIDE.test(text)) return {kind: 'wide'};
  const segments = text.split('/');
  const wild = segments.findIndex(segment => /[*?]/.test(segment));
  const fixed = (wild < 0 ? segments : segments.slice(0, wild)).join('/'), tail = wild < 0 ? '' : segments.slice(wild).join('/');
  // A bare glob such as `*.css` or `**/*.ts` matches anywhere in the workspace.
  if (wild === 0) return {kind: 'write', pattern: text};
  const root = canonicalPath(cwd), target = canonicalPath(resolve(cwd, fixed || '.'));
  if (scratch && within(scratch, target)) return {kind: 'scratch'};
  if (!within(root, target)) return {kind: 'outside'};
  const pattern = [relative(root, target).replaceAll('\\', '/'), tail].filter(Boolean).join('/');
  return pattern ? {kind: 'write', pattern} : {kind: 'wide'};
}

/** Validates a dispatch against the principal's profile. Fixable mistakes are normalised with a note; only a few shapes are refused, each with its fix. */
export function planDispatch(input: {
  readonly jobs: readonly AutomaJobArgs[];
  readonly style?: string | undefined;
  readonly release: readonly string[];
  readonly profile: AutomaProfile;
  readonly cwd: string;
  /** The dispatcher's own scratchpad subdirectory. */
  readonly scratch?: string | undefined;
  readonly retained: readonly RetainedGrant[];
  /** Who currently holds a write pattern, when it is not the principal. */
  readonly holder: (pattern: string) => string | undefined;
  /** The base worker system prompt; the style flavour is appended. */
  readonly system: string;
}): {ok: true; jobs: readonly PlannedJob[]; style: string; parallel?: number; /** Ids this dispatch really releases. */ release: readonly string[]; note?: string} | {ok: false; error: string} {
  const {profile, cwd} = input;
  const refuse = (error: string) => ({ok: false as const, error});
  const live = new Set(input.retained.map(item => item.id));
  const notes: string[] = [];
  // Only real ids of this dispatcher's kept workers are honoured; anything else is dropped with a note, never an error.
  const continuing = new Set<string>();
  const wantsContinue = (job: AutomaJobArgs): string | undefined => {
    if (!job.continue) return undefined;
    const label = job.title ?? titleFrom(job.brief);
    if (live.has(job.continue) && !continuing.has(job.continue)) {continuing.add(job.continue); return job.continue;}
    notes.push(continuing.has(job.continue) ? `Kept worker "${job.continue}" is already continued by an earlier job in this dispatch; "${label}" ran as a fresh single-use job.`
      : `"${job.continue}" is not a live kept worker of yours (they end with your task); "${label}" ran as a fresh single-use job, so its brief must stand alone.`);
    return undefined;
  };
  const resolved = input.jobs.map(job => ({job, resume: wantsContinue(job)}));
  const release = [...new Set(input.release)].filter(id => {
    if (!live.has(id)) {notes.push(`Release ignored: "${id}" is not a live kept worker of yours.`); return false;}
    if (continuing.has(id)) {notes.push(`Release of "${id}" ignored: it is continued in this dispatch.`); return false;}
    return true;
  });
  const fresh = resolved.filter(item => !item.resume);
  const choice = chooseStyle(profile, input.style, fresh.some(item => item.job.writes?.length));
  if (choice.note) notes.push(choice.note);
  const style = profile.styles[choice.name]!;
  const system = input.system + (style.flavor ? '\n\nStyle: ' + style.flavor : '');
  const planned: PlannedJob[] = [];
  let slots = AUTOMA_MAX_RETAINED - input.retained.filter(item => !release.includes(item.id)).length;
  const heldBy = (files: readonly string[]) => files.flatMap(pattern => {
    const holder = input.holder(pattern);
    return holder ? [`${pattern} is held by ${holder}`] : [];
  });
  const coordinate = (held: readonly string[]) => held.length ? {denial: held.join('; ') + '. Coordinate with its owner, then dispatch again.'} : {};
  for (const {job: raw, resume} of resolved) {
    const {continue: _requested, ...base} = raw;
    const job = {...base, title: raw.title ?? titleFrom(raw.brief)};
    if (resume) {
      const instance = input.retained.find(item => item.id === resume)!;
      if (job.writes) notes.push(`Kept worker "${resume}" keeps the writes it was created with; \`writes\` on "${job.title}" was ignored.`);
      const {writes: _writes, ...rest} = job;
      planned.push({job: {...rest, continue: resume}, grant: instance.grant, system: instance.system, ...coordinate(heldBy(instance.grant.writes))});
      continue;
    }
    const writes: string[] = [];
    for (const entry of job.writes ?? []) {
      const found = normalizeWrite(entry, cwd, input.scratch);
      if (found.kind === 'wide') return refuse(`\`writes\` on "${job.title}" names the whole workspace (${entry}). Name the specific files or directories the job edits (for example "src/parser/**"), or remove \`writes\` if the job only reads.`);
      if (found.kind === 'scratch') continue;
      if (found.kind === 'outside') {notes.push(`\`writes\` entry "${entry}" on "${job.title}" is outside the workspace and was dropped (your scratchpad is always writable without a grant).`); continue;}
      if (!writes.includes(found.pattern)) writes.push(found.pattern);
    }
    let keep = job.keep;
    if (keep) {
      if (slots > 0) slots--;
      else {keep = false; notes.push(`"${job.title}" was not kept: at most ${AUTOMA_MAX_RETAINED} workers may be kept at once. Release one with \`release\`, or let it end with your task.`);}
    }
    const {writes: _given, ...rest} = job;
    const grant: JobGrant = {writes, exclusive: profile.exclusive ?? []};
    planned.push({job: {...rest, ...(writes.length ? {writes} : {}), keep}, grant, system, model: style.model ?? profile.model, ...coordinate(heldBy(writes))});
  }
  for (let left = 0; left < planned.length; left++) {
    for (let right = left + 1; right < planned.length; right++) {
      for (const a of planned[left]!.grant.writes) for (const b of planned[right]!.grant.writes) {
        if (patternsOverlap(a, b, cwd)) return refuse(`Jobs "${planned[left]!.job.title}" and "${planned[right]!.job.title}" have overlapping writes: ${a} and ${b}. Give each job a disjoint set, or merge them into one job.`);
      }
    }
  }
  return {ok: true, jobs: planned, style: choice.name, ...(style.parallel ? {parallel: style.parallel} : {}), release, ...(notes.length ? {note: notes.join('\n')} : {})};
}
