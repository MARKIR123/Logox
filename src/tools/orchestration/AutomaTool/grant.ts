import {resolve} from 'node:path';
import {shellWords} from '../../../permissions/shell.js';
import {classifyShellCommand} from '../../ShellTool/classify.js';
import {inside, ownsPath, patternBase, patternsOverlap} from '../../ownership.js';
import type {AutomaProfile} from './preset.js';

/** What one job may touch. It only narrows: the principal's tool access and the permission engine still apply to every call. */
export interface JobGrant {
  /** Read scope; absent means the whole workspace. */
  readonly read?: readonly string[];
  readonly files: readonly string[];
  readonly commands: readonly string[];
  readonly exclusive: readonly string[];
}

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch'] as const;

export function grantTools(grant: JobGrant): readonly string[] {
  return [...READ_TOOLS, ...(grant.files.length ? ['Edit', 'Write'] : []), ...(grant.commands.length ? ['Shell'] : [])];
}

function matchesCommand(prefix: string, command: string): boolean {
  const parsed = shellWords(command);
  if (parsed.compound || parsed.dynamic) return false;
  return shellWords(prefix).words.every((word, index) => word.toLowerCase() === parsed.words[index]?.toLowerCase());
}

export function isExclusiveCommand(grant: JobGrant, command: string): boolean {
  return grant.exclusive.some(prefix => matchesCommand(prefix, command));
}

export function shellDenial(grant: JobGrant, command: string): string | undefined {
  if (grant.commands.some(prefix => matchesCommand(prefix, command))) return undefined;
  // A narrowed read scope cannot be checked against arbitrary shell words, so read-only commands need the whole workspace.
  if (!grant.read && classifyShellCommand(command) !== 'command') return undefined;
  return `Command is outside this job's grant. Allowed command prefixes: ${grant.commands.join(', ') || 'none'}. Compound and dynamic commands never match.`;
}

export interface GrantPath {
  /** The requested path and the base it is measured from, before and after resolving links; both must pass. */
  readonly lexical: string;
  readonly cwd: string;
  readonly canonical: string;
  readonly root: string;
}

export function pathDenial(tool: string, grant: JobGrant, path: GrantPath): string | undefined {
  const both = (check: (target: string, base: string) => boolean) => check(path.lexical, path.cwd) && check(path.canonical, path.root);
  if (tool === 'Edit' || tool === 'Write') {
    return both((target, base) => inside(base, target) && ownsPath(grant.files, target, base)) ? undefined
      : `Path is outside this job's write grant: ${path.lexical}. Report it in notes instead.`;
  }
  if (!inside(path.root, path.canonical)) return `Path is outside the workspace: ${path.lexical}.`;
  if (!grant.read) return undefined;
  const scope = [...grant.read, ...grant.files];
  const allowed = tool === 'Read'
    ? both((target, base) => ownsPath(scope, target, base))
    : both((target, base) => scope.some(pattern => inside(resolve(base, patternBase(pattern, base)), target)));
  return allowed ? undefined : `Path is outside this job's read scope (${scope.join(', ')}): ${path.lexical}. Search within the scope.`;
}

export interface AutomaJobArgs {
  readonly title?: string | undefined;
  readonly brief: string;
  readonly read?: readonly string[] | undefined;
  readonly files?: readonly string[] | undefined;
  readonly commands?: readonly string[] | undefined;
  readonly output?: 'text' | 'json' | undefined;
  readonly persistence?: boolean | undefined;
  readonly instance?: string | undefined;
}

export interface RetainedGrant {
  readonly id: string;
  readonly grant: JobGrant;
}

export interface PlannedJob {
  readonly job: AutomaJobArgs & {readonly title: string};
  readonly grant: JobGrant;
  readonly model?: string | undefined;
  readonly denial?: string | undefined;
}

export const AUTOMA_MAX_RETAINED = 2;

const WORKSPACE_WIDE = /^(?:\.\/?|\*+|\*\*\/\*+|\.\/\*+|\.\/\*\*\/\*+)$/;

export function titleFrom(brief: string): string {
  const line = brief.trim().split(/\r?\n/)[0]!.replace(/\s+/g, ' ');
  return line.length <= 60 ? line : line.slice(0, 59).trimEnd() + '…';
}

function filesError(pattern: string, cwd: string): string | undefined {
  const text = pattern.trim().replaceAll('\\', '/');
  if (WORKSPACE_WIDE.test(text) || text === '/') return `\`files\` must name specific paths, not the whole workspace: ${pattern}`;
  if (text.split('/').includes('..') || !inside(cwd, resolve(cwd, text.replace(/[*?].*$/, '')))) return `\`files\` must stay inside the workspace: ${pattern}. Workers cannot write to the scratchpad; have a command print to stdout, or write the file yourself.`;
  return undefined;
}

/** Validates a dispatch against the principal's profile before any worker starts; a refused dispatch has no side effects. */
export function planDispatch(input: {
  readonly jobs: readonly AutomaJobArgs[];
  readonly preset?: string | undefined;
  readonly release: readonly string[];
  readonly profile: AutomaProfile;
  readonly cwd: string;
  readonly retained: readonly RetainedGrant[];
  /** Who currently holds a write pattern, when it is not the principal. */
  readonly holder: (pattern: string) => string | undefined;
}): {ok: true; jobs: readonly PlannedJob[]; note?: string} | {ok: false; error: string} {
  const {profile, cwd} = input;
  const refuse = (error: string) => ({ok: false as const, error});
  const needsWrite = input.jobs.some(job => !job.instance && job.files?.length);
  const wanted = input.jobs.flatMap(job => job.instance ? [] : job.commands ?? []);
  const fits = (name: string) => {
    const item = profile.presets[name]!;
    return (!needsWrite || item.tools === 'write') && wanted.every(command => (item.commands ?? []).some(prefix => matchesCommand(prefix, command)));
  };
  let note: string | undefined;
  let presetName = input.preset ?? '';
  if (!Object.hasOwn(profile.presets, presetName)) {
    // Presets are a means, not a decision: pick the first one that covers the files and commands the jobs ask for.
    const chosen = [profile.default_preset, ...Object.keys(profile.presets)].find(fits) ?? profile.default_preset;
    if (input.preset) note = `Preset "${input.preset}" does not exist (available: ${Object.keys(profile.presets).join(', ')}); used "${chosen}".`;
    presetName = chosen;
  }
  const preset = profile.presets[presetName]!;
  const planned: PlannedJob[] = [];
  const resumed = new Set<string>();
  let fresh = 0;
  for (const raw of input.jobs) {
    const job = {...raw, title: raw.title ?? titleFrom(raw.brief)};
    if (job.instance) {
      const instance = input.retained.find(item => item.id === job.instance);
      if (!instance) return refuse(`Automa instance "${job.instance}" does not exist. Instances end with your task, on failure, on cancel and on release; dispatch a fresh job with a complete brief.`);
      if (input.release.includes(job.instance)) return refuse(`Automa instance "${job.instance}" cannot be resumed and released in one dispatch.`);
      if (resumed.has(job.instance)) return refuse(`Automa instance "${job.instance}" appears twice in one dispatch.`);
      if (job.read || job.files || job.commands) return refuse(`Automa instance "${job.instance}" keeps the grant it was created with; drop read, files and commands, or dispatch a fresh job.`);
      resumed.add(job.instance);
      const held = instance.grant.files.flatMap(pattern => {
        const holder = input.holder(pattern);
        return holder ? [`${pattern} is held by ${holder}`] : [];
      });
      planned.push({job, grant: instance.grant, ...(held.length ? {denial: held.join('; ') + '. Coordinate with its owner, then dispatch again.'} : {})});
      continue;
    }
    if (job.persistence) fresh++;
    if (job.files?.length && preset.tools !== 'write') {
      const writable = Object.entries(profile.presets).filter(([, item]) => item.tools === 'write').map(([name]) => name);
      return refuse(`Preset "${presetName}" is read-only, so \`files\` cannot be granted. ${writable.length ? 'Writable presets: ' + writable.join(', ') + '.' : 'This actor has no writable preset.'}`);
    }
    for (const pattern of job.files ?? []) {
      const error = filesError(pattern, cwd);
      if (error) return refuse(error);
    }
    const allowed = preset.commands ?? [];
    const outside = (job.commands ?? []).filter(command => !allowed.some(prefix => matchesCommand(prefix, command)));
    if (outside.length) {
      const others = Object.entries(profile.presets).filter(([name, item]) => name !== presetName && (item.commands?.length)).map(([name, item]) => `${name} (${item.commands!.join(', ')})`);
      return refuse(`Preset "${presetName}" does not allow the command prefix: ${outside.join(', ')}. Allowed: ${allowed.join(', ') || 'none'}.${others.length ? ' Other presets: ' + others.join('; ') + '.' : ''} Put the command in a Shell call of your own if no preset fits.`);
    }
    const commands = job.commands ?? allowed;
    const exclusive = (preset.exclusive ?? []).filter(prefix => commands.some(command => matchesCommand(prefix, command)));
    const grant: JobGrant = {...(job.read?.length ? {read: job.read} : {}), files: job.files ?? [], commands, exclusive};
    const held = (job.files ?? []).flatMap(pattern => {
      const holder = input.holder(pattern);
      return holder ? [`${pattern} is held by ${holder}`] : [];
    });
    planned.push({job, grant, model: preset.model ?? profile.model, ...(held.length ? {denial: held.join('; ') + '. Coordinate with its owner, then dispatch again.'} : {})});
  }
  const keeping = input.retained.filter(item => !input.release.includes(item.id)).length;
  if (keeping + fresh > AUTOMA_MAX_RETAINED) {
    return refuse(`At most ${AUTOMA_MAX_RETAINED} persistent Automa instances may be kept at once (${keeping} kept, ${fresh} requested). Release one first, or leave persistence off.`);
  }
  for (let left = 0; left < planned.length; left++) {
    for (let right = left + 1; right < planned.length; right++) {
      for (const a of planned[left]!.grant.files) for (const b of planned[right]!.grant.files) {
        if (patternsOverlap(a, b, cwd)) return refuse(`Jobs "${planned[left]!.job.title}" and "${planned[right]!.job.title}" have overlapping files: ${a} and ${b}. Give each job a disjoint file set.`);
      }
    }
  }
  return {ok: true, jobs: planned, ...(note ? {note} : {})};
}
