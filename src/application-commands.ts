import type {CommandTab, CommandToggle, TabLine, PermissionsPageData} from './runtime/command-surface.js';
import {row, tabContent} from './commands/tab-rows.js';
import type {StatusbarAppearance} from './config/statusbar-preferences.js';
import type {StageStatus} from './runtime/stage-status.js';

export interface ApplicationCommandContext {
  readonly session: string;
  readonly pageOwner: string;
  readonly permissions: {
    readonly mode: string;
    readonly description: string;
    readonly color?: string;
    readonly lines: readonly TabLine[];
    readonly modes?: readonly {readonly id: string; readonly description: string}[];
    readonly page?: PermissionsPageData;
    readonly readonly_concurrency: number;
    readonly approvalTokens: number;
  };
  readonly statusbarModules: readonly CommandToggle[];
  readonly statusbarAppearance?: StatusbarAppearance;
  readonly statusbarStatus?: StageStatus;
  readonly statusLines: readonly TabLine[];
  readonly configLines?: readonly TabLine[] | undefined;
  readonly usageLines: readonly TabLine[];
  readonly providersLines: readonly TabLine[];
  readonly commandsLines: readonly TabLine[];
}

/** Tabbed command pages. `/settings` is its own surface (`CommandSurfaces.openSettings`) and opens the statusbar and permissions pages from here. */
export function createCommandTabsFor(
  command: string,
  context: ApplicationCommandContext
): {title: string; tabs: readonly CommandTab[]; initialTab: string} | null {
  const normalized = command.trim().toLowerCase();
  const statusbarTab: CommandTab = {
    id: 'statusbar', title: 'Statusbar', lines: [], toggles: context.statusbarModules,
    statusbar: {appearance: context.statusbarAppearance ?? {style: 'pipes', colorScheme: 'theme'},
      status: context.statusbarStatus ?? {ownerId: context.pageOwner, name: context.pageOwner, state: 'ready'}},
  };

  if (normalized === '/config') {
    return {
      title: 'Effective Configuration',
      tabs: [{id: 'config', title: 'Config', ...tabContent(context.configLines ?? [])}],
      initialTab: 'config',
    };
  }

  if (normalized === '/permissions') {
    return {
      title: 'Permissions',
      tabs: [{
        id: 'permissions',
        title: 'Permissions',
        ...(context.permissions.color ? {color: context.permissions.color} : {}),
        ...(context.permissions.page ? {permissions: context.permissions.page}
          : context.permissions.modes ? {mode: {current: context.permissions.mode, options: context.permissions.modes}} : {}),
        ...tabContent(context.permissions.lines),
      }],
      initialTab: 'permissions',
    };
  }

  if (normalized === '/statusbar') {
    return {
      title: 'Statusbar Modules',
      tabs: [statusbarTab],
      initialTab: 'statusbar',
    };
  }

  if (normalized === '/status' || normalized === '/usage') {
    return {
      title: 'Status & Usage',
      tabs: [
        {
          id: 'status',
          title: 'Status',
          ...tabContent(context.statusLines),
        },
        ...(context.configLines ? [{
          id: 'config',
          title: 'Config',
          ...tabContent(context.configLines),
        }] : []),
        {
          id: 'usage',
          title: 'Usage',
          ...tabContent(context.usageLines),
        },
      ],
      initialTab: normalized === '/usage' ? 'usage' : 'status',
    };
  }

  if (normalized === '/providers') {
    return {
      title: 'Providers',
      tabs: [{
        id: 'providers',
        title: 'Providers',
        ...tabContent(context.providersLines),
      }],
      initialTab: 'providers',
    };
  }

  if (normalized === '/help' || normalized === '/commands') {
    return {
      title: 'Help & Commands',
      tabs: [{
        id: 'commands',
        title: 'Commands',
        ...tabContent(context.commandsLines),
      }],
      initialTab: 'commands',
    };
  }

  return null;
}
