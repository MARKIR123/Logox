import type {CommandTab, CommandToggle, CommandResult} from './runtime/command-surface.js';
import {applyThemePreset, applyCursorStyle, type CursorStyleName} from './config/theme-presets.js';
import type {StatusbarAppearance} from './config/statusbar-preferences.js';
import type {StageStatus} from './runtime/stage-status.js';

export interface ApplicationCommandContext {
  readonly session: string;
  readonly pageOwner: string;
  readonly currentTheme: string;
  readonly themeOptions: readonly string[];
  readonly currentCursor: CursorStyleName;
  readonly motion: boolean;
  readonly permissions: {
    readonly mode: string;
    readonly description: string;
    readonly color?: string;
    readonly lines: readonly string[];
    readonly readonly_concurrency: number;
    readonly approvalTokens: number;
  };
  readonly statusbarModules: readonly CommandToggle[];
  readonly statusbarAppearance?: StatusbarAppearance;
  readonly statusbarStatus?: StageStatus;
  readonly statusLines: readonly string[];
  readonly configLines?: readonly string[] | undefined;
  readonly usageLines: readonly string[];
  readonly providersLines: readonly string[];
  readonly actorsLines: readonly string[];
  readonly commandsLines: readonly string[];
}

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
      tabs: [{id: 'config', title: 'Config', lines: context.configLines ?? []}],
      initialTab: 'config',
    };
  }

  if (normalized === '/settings' || normalized === '/animations') {
    const toggles: CommandToggle[] = [
      {
        id: 'theme',
        label: 'Theme preset',
        value: context.currentTheme,
        options: [...context.themeOptions],
        enabled: true,
      },
      {
        id: 'cursor',
        label: 'Cursor style',
        value: context.currentCursor,
        options: ['Block █', 'Underline _', 'Bar |'],
        enabled: true,
      },
      {
        id: 'motion',
        label: 'UI animations and motion waves',
        enabled: context.motion,
      },
    ];

    return {
      title: 'Settings',
      tabs: [{
        id: 'settings',
        title: 'Settings',
        lines: [],
        toggles,
      }, statusbarTab],
      initialTab: 'settings',
    };
  }

  if (normalized === '/permissions') {
    return {
      title: 'Permissions',
      tabs: [{
        id: 'permissions',
        title: 'Permissions',
        ...(context.permissions.color ? {color: context.permissions.color} : {}),
        lines: [
          `Current mode: ${context.permissions.mode} · ${context.permissions.description} (press Space or m to toggle mode)`,
          '─────────────────────────────────────────────────────────────',
          ...context.permissions.lines,
        ],
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
          lines: context.statusLines,
        },
        ...(context.configLines ? [{
          id: 'config',
          title: 'Config',
          lines: context.configLines,
        }] : []),
        {
          id: 'usage',
          title: 'Usage',
          lines: context.usageLines,
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
        lines: context.providersLines,
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
        lines: context.commandsLines,
      }],
      initialTab: 'commands',
    };
  }

  if (normalized === '/actors' || normalized === '/ensemble') {
    return {
      title: 'Actor Ensemble',
      tabs: [{
        id: 'actors',
        title: 'Actors',
        lines: context.actorsLines,
      }],
      initialTab: 'actors',
    };
  }

  return null;
}

export async function saveConfigToggles(
  items: readonly CommandToggle[],
  options: {
    saveMotion(enabled: boolean): Promise<void>;
    stdout?: {write(data: string): void};
    onThemeChange?(themeName: string): Promise<void> | void;
    onCursorChange?(cursorName: string): Promise<void> | void;
  }
): Promise<CommandResult> {
  const themeItem = items.find(it => it.id === 'theme');
  if (themeItem?.value) {
    applyThemePreset(themeItem.value);
    options.onThemeChange?.(themeItem.value);
  }

  const cursorItem = items.find(it => it.id === 'cursor');
  if (cursorItem?.value) {
    applyCursorStyle(cursorItem.value as CursorStyleName, options.stdout as any);
    options.onCursorChange?.(cursorItem.value);
  }

  const motionItem = items.find(it => it.id === 'motion');
  if (motionItem) {
    await options.saveMotion(motionItem.enabled);
  }

  return {message: 'Settings saved.', presentation: 'status'};
}
