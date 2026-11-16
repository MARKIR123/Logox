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
  /** Narrows the tools offered to the worker; absent means all of them. Only runtime-built jobs (the brief check) set it, never a dispatcher. */
  readonly tools?: readonly string[];
}

const TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'Edit', 'Write', 'Shell'] as const;

export function grantTools(grant: JobGrant): readonly string[] {
  return grant.tools ?? TOOLS;
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
  /** How open the problem is; absent counts as `bounded`. */
  readonly scope?: 'exact' | 'bounded' | 'open' | undefined;
  /** The checks that define done; shown to the worker and beside its claims in the result. */
  readonly acceptance?: readonly string[] | undefined;
  /** Workspace paths or globs this job may edit; absent means read-only. */
  readonly writes?: readonly string[] | undefined;
  /** Accepted for compatibility and ignored: every finished worker can be continued. */
  readonly keep?: boolean | undefined;
  /** Id of a finished worker of this dispatcher's current task to continue; a closed or unknown id refuses the call. */
  readonly continue?: string | undefined;
  /** The job must look at images: it runs on a model that can see them (the worker model, else the vision fallback) or is refused. */
  readonly vision?: boolean | undefined;
}

export interface RetainedGrant {
  readonly id: string;
  readonly grant: JobGrant;
  readonly system: string;
}

export interface PlannedJob {
  /** The readable id (`T1`, `K2`): given when the job is dispatched, kept by a continued job. */
  readonly id?: string | undefined;
  readonly job: AutomaJobArgs & {readonly title: string};
  readonly grant: JobGrant;
  readonly model?: string | undefined;
  /** The worker's full system prompt (base contract plus style flavour). */
  readonly system: string;
  readonly denial?: string | undefined;
}

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
  /** The finished workers of this dispatcher's current task the call names (to continue or release). */
  readonly retained: readonly RetainedGrant[];
  /** Most jobs one call may carry (`[automa] max_per_dispatch`). */
  readonly maxJobs: number;
  /** Who currently holds a write pattern, when it is not the principal. */
  readonly holder: (pattern: string) => string | undefined;
  /** The base worker system prompt; the style flavour is appended. */
  readonly system: string;
}): {ok: true; jobs: readonly PlannedJob[]; style: string; parallel?: number; /** Ids this dispatch really releases. */ release: readonly string[]; note?: string} | {ok: false; error: string} {
  const {profile, cwd} = input;
  const refuse = (error: string) => ({ok: false as const, error});
  const live = new Set(input.retained.map(item => item.id));
  const notes: string[] = [];
  if (input.jobs.length > input.maxJobs) return refuse(`Too many jobs: ${input.jobs.length}. This setup allows ${input.maxJobs} per call (\`[automa] max_per_dispatch\`). Send the first ${input.maxJobs} now and the rest in a second call, or merge related slices into one job.`);
  // A continued job names a finished worker of this dispatcher's current task; a closed or unknown id is refused so the brief is never sent to a worker that does not exist.
  const continuing = new Set<string>();
  for (const job of input.jobs) {
    if (!job.continue) continue;
    if (!live.has(job.continue)) return refuse(`Worker ${job.continue} is closed or unknown; dispatch a new job.`);
    if (continuing.has(job.continue)) return refuse(`Worker ${job.continue} is continued by two jobs of this call; continue it once, with one brief.`);
    continuing.add(job.continue);
  }
  const resolved = input.jobs.map(job => ({job, resume: job.continue}));
  if (input.jobs.some(job => job.keep)) notes.push('keep is no longer needed: every finished worker can be continued.');
  const release = [...new Set(input.release)].filter(id => {
    if (!live.has(id)) {notes.push(`Release ignored: "${id}" is not a live worker of yours.`); return false;}
    if (continuing.has(id)) {notes.push(`Release of "${id}" ignored: it is continued in this dispatch.`); return false;}
    return true;
  });
  const fresh = resolved.filter(item => !item.resume);
  const choice = chooseStyle(profile, input.style, fresh.some(item => item.job.writes?.length));
  if (choice.note) notes.push(choice.note);
  const style = profile.styles[choice.name]!;
  const system = input.system + (style.flavor ? '\n\nStyle: ' + style.flavor : '');
  const planned: PlannedJob[] = [];
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
      if (job.writes) notes.push(`Worker "${resume}" keeps the writes it was created with; \`writes\` on "${job.title}" was ignored.`);
      const {writes: _writes, keep: _keep, ...rest} = job;
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
    const {writes: _given, keep: _keep, ...rest} = job;
    const grant: JobGrant = {writes, exclusive: profile.exclusive ?? []};
    planned.push({job: {...rest, ...(writes.length ? {writes} : {})}, grant, system, model: style.model ?? profile.model, ...coordinate(heldBy(writes))});
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
