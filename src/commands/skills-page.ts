/**
 * The `/skills` page: a Skills tab (every skill the viewed window can use, stale and pinned ones marked) and an Archived tab listing what the
 * curator moved to `.archive/`, with a restore action (`n` / `p` pick, `r` restores; the footer actions are clickable). It owns only the
 * selected row; the data comes from `Resources` and the curator.
 */
import type {ActorCatalog} from '../actors/catalog.js';
import type {Resources, SkillResource} from '../resources/manager.js';
import type {CommandResult, TabAction, TabLine} from '../runtime/command-surface.js';
import {row} from './tab-rows.js';

export interface SkillsPageDeps {
  resources: Resources;
  actors: Pick<ActorCatalog, 'find'>;
  /** The window whose skills the Skills tab shows. */
  pageOwner(): string;
  refreshPage(): void;
}
export interface SkillsPageContent {
  readonly skills: readonly TabLine[];
  readonly archived: readonly TabLine[];
  readonly archivedActions: readonly TabAction[];
}

export const SKILLS_ARCHIVE_TAB = 'archived';
const archivedActions: readonly TabAction[] = [
  {id: 'archived_next', label: 'Next', key: 'n'}, {id: 'archived_prev', label: 'Previous', key: 'p'}, {id: 'restore', label: 'Restore', key: 'r'}];

export function createSkillsPage(deps: SkillsPageDeps) {
  const {resources, actors, pageOwner, refreshPage} = deps;
  let selected = 0;
  const archivedList = (): readonly SkillResource[] => [...resources.archived()].sort((a, b) => a.name.localeCompare(b.name));
  const current = (): SkillResource | undefined => {
    const list = archivedList();
    selected = Math.max(0, Math.min(selected, list.length - 1));
    return list[selected];
  };
  const content = (): SkillsPageContent => {
    const owner = pageOwner(), stale = resources.curator?.stale() ?? new Set<string>();
    const live = resources.skillsFor({actorId: owner, skills: actors.find(owner)?.skills ?? []});
    const skills: TabLine[] = live.length ? live.flatMap(item => [
      row.field(item.name + (item.pinned ? ' [pinned]' : '') + (stale.has(item.name) ? ' [stale]' : ''), item.description),
      row.muted('  ' + item.path)]) : [row.text('No skills found')];
    if (live.some(item => stale.has(item.name))) skills.push(row.blank(), row.muted('Stale: unused for a while; archived to .archive/ if still unused later. Add `pinned: true` to a skill to keep it.'));
    const list = archivedList(), chosen = current();
    const archived: TabLine[] = list.length ? [
      row.muted('Unused skills the curator moved to .archive/. Skill search still finds them; n/p pick one, r restores it.'), row.blank(),
      ...list.flatMap(item => [row.text((item === chosen ? '❯ ' : '  ') + item.name + (item.category ? ' · ' + item.category : '') + ': ' + item.description),
        row.muted('    ' + item.path)])] : [row.text('No archived skills')];
    return {skills, archived, archivedActions: list.length ? archivedActions : []};
  };
  /** Runs one action of the Archived tab; unknown actions do nothing. */
  const action = async (name: string): Promise<CommandResult> => {
    const list = archivedList();
    if (name === 'archived_next' && list.length) {selected = (selected + 1) % list.length; refreshPage(); return {};}
    if (name === 'archived_prev' && list.length) {selected = (selected - 1 + list.length) % list.length; refreshPage(); return {};}
    if (name === 'restore') {
      const chosen = current();
      if (!chosen || !resources.curator) return {};
      try {
        await resources.curator.restore(chosen.name);
        refreshPage();
        return {message: 'Restored skill ' + chosen.name, presentation: 'status'};
      } catch (error) {
        return {message: 'Could not restore ' + chosen.name + ': ' + (error instanceof Error ? error.message : 'failed'), kind: 'command_error', presentation: 'status'};
      }
    }
    return {};
  };
  return {content, action};
}
export type SkillsPage = ReturnType<typeof createSkillsPage>;
