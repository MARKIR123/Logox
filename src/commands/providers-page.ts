/**
 * The `/providers` page of one session: which provider is being viewed (`viewingProviderIndex`), the last test or sync
 * status of each provider, the page rows, and the page actions (next/previous, test, refresh models, logout with its
 * confirmation). It owns both pieces of state; it reads the registry and model pool and deletes through the injected
 * provider-management functions.
 */
import type {ProviderRegistry} from '../providers/registry.js';
import type {ModelPool} from '../providers/model-pool.js';
import type {ProviderManagement} from '../providers/management.js';
import type {CommandResult, TabLine} from '../runtime/command-surface.js';
import {row} from './tab-rows.js';

export interface ProvidersPageDeps {
  registry: ProviderRegistry; modelPool: ModelPool; management: Pick<ProviderManagement, 'providerUsers' | 'usersLabel' | 'removeProvider'>;
  signal: AbortSignal;
  /** The session selection, used to pick the first viewed provider. */
  selection(): {provider: string};
  isEnsembleBusy(): boolean;
  /** The window a logout is attributed to. */
  commandOwner(): string;
  refreshPage(): void;
}

export function createProvidersPage(deps: ProvidersPageDeps) {
  const {registry, modelPool, management, signal, selection, isEnsembleBusy, commandOwner, refreshPage} = deps;
  let viewingProviderIndex = -1;
  const providerStatuses = new Map<string, string>();
  const rows = (): TabLine[] => {
    const names = registry.names();
    if (names.length === 0) {
      return [row.heading('Connected Providers'), row.rule(), row.text('No providers currently configured.'), row.blank(),
        row.text('Run /login to add an official provider or custom reverse proxy.')];
    }
    if (viewingProviderIndex < 0 || viewingProviderIndex >= names.length) {
      const activeIdx = names.indexOf(selection().provider);
      viewingProviderIndex = activeIdx >= 0 ? activeIdx : 0;
    }
    const current = names[viewingProviderIndex]!;
    const poolModels = modelPool.snapshot();
    const currentModels = poolModels.filter(m => m.provider === current);

    // Horizontal Provider Navigation
    const navItems = names.map((name, i) => {
      const count = poolModels.filter(m => m.provider === name).length;
      return i === viewingProviderIndex ? '❯ [ ' + name + ' (' + count + ') ]' : '  ' + name + ' (' + count + ')';
    }).join('    ');

    const candSettings = registry.candidate(current).selection();
    const statusText = providerStatuses.get(current) ?? '● Ready (press [t] to test)';

    const lines: TabLine[] = [
      row.text(navItems),
      row.rule(),
      row.field('Provider', current),
      row.field('Base URL', candSettings.baseUrl),
      row.field('Status', statusText),
      row.field('Models count', currentModels.length),
      row.blank(),
      row.rule('Models (' + currentModels.length + ')'),
    ];

    if (currentModels.length === 0) {
      lines.push(row.text('  No models cached. Press [r] to fetch models from provider.'));
    } else {
      for (const m of currentModels) {
        const win = m.window ? (Math.round(m.window / 1000) + 'k') : '128k';
        const eff = m.thinkingLevels && m.thinkingLevels.length > 0
          ? '✦ ' + m.thinkingLevels.filter((l: string) => l !== 'auto').join(' / ')
          : '-';
        const offlineTag = m.isOffline ? ' [offline]' : '';
        lines.push(row.bullet(m.id + offlineTag + ' · ' + win + ' · Thinking: ' + eff));
      }
    }
    return lines;
  };
  /** Runs one action of the providers tab; unknown actions do nothing. */
  const action = async (name: string): Promise<CommandResult> => {
    const names = registry.names();
    if (name === 'next_provider' && names.length > 0) {
      viewingProviderIndex = (viewingProviderIndex + 1) % names.length;
      refreshPage();
      return {};
    }
    if (name === 'prev_provider' && names.length > 0) {
      viewingProviderIndex = (viewingProviderIndex - 1 + names.length) % names.length;
      refreshPage();
      return {};
    }
    const current = names[viewingProviderIndex];
    if (!current) return {};
    if (name === 'test') {
      providerStatuses.set(current, 'Testing connection...');
      refreshPage();
      const start = Date.now();
      try {
        const candidate = registry.candidate(current);
        await candidate.check(signal);
        const elapsed = Date.now() - start;
        providerStatuses.set(current, '● Connected (' + elapsed + 'ms)');
        refreshPage();
        return {message: "Provider '" + current + "' connected (" + elapsed + "ms)", presentation: 'status'};
      } catch (error) {
        providerStatuses.set(current, '○ Offline (' + (error instanceof Error ? error.message : 'failed') + ')');
        refreshPage();
        return {message: "Provider '" + current + "' connection failed", kind: 'command_error', presentation: 'status'};
      }
    }
    if (name === 'refresh') {
      providerStatuses.set(current, 'Refreshing models...');
      refreshPage();
      try {
        const pool = await modelPool.syncProvider(current, signal);
        const count = pool.filter(m => m.provider === current).length;
        providerStatuses.set(current, '● Connected (' + count + ' models synced)');
        refreshPage();
        return {message: "Refreshed " + count + " models from '" + current + "'", presentation: 'status'};
      } catch (error) {
        providerStatuses.set(current, '○ Sync failed');
        refreshPage();
        return {message: "Failed to refresh models from '" + current + "'", kind: 'command_error', presentation: 'status'};
      }
    }
    if (name === 'logout') {
      if (isEnsembleBusy()) return {message: 'Tasks are running. Wait or cancel before unregistering provider.', kind: 'command_error', presentation: 'status'};
      const using = management.usersLabel(management.providerUsers(current));
      return {confirm: {action: 'confirm_logout', prompt: "Log out of provider '" + current + "' and remove its credentials?" + (using.length ? ' In use by: ' + using.join(', ') + '.' : '')}};
    }
    if (name === 'confirm_logout') {
      if (isEnsembleBusy()) return {message: 'Tasks are running. Wait or cancel before unregistering provider.', kind: 'command_error', presentation: 'status'};
      await management.removeProvider(current, commandOwner());
      if (viewingProviderIndex >= registry.names().length) {
        viewingProviderIndex = Math.max(0, registry.names().length - 1);
      }
      refreshPage();
      return {message: "Logged out provider '" + current + "'", presentation: 'status'};
    }
    return {};
  };
  return {rows, action};
}
export type ProvidersPage = ReturnType<typeof createProvidersPage>;
