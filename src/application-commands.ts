import type {CommandTab, CommandToggle, CommandResult} from './runtime/command-surface.js';
import {applyThemePreset, applyCursorStyle, type ThemePresetName, type CursorStyleName} from './config/theme-presets.js';

export interface ApplicationCommandContext {
  readonly session: string;
  readonly pageOwner: string;
  readonly currentTheme: ThemePresetName;
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

  if (normalized === '/config') {
    const toggles: CommandToggle[] = [
      {
        id: 'theme',
        label: 'Theme preset',
        value: context.currentTheme,
        options: ['Logox Dark', 'Claude Warm', 'Nord Polar', 'Monokai Pro', 'Tokyo Night'],
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
        id: 'config',
        title: 'Settings',
        lines: context.configLines ?? [],
        toggles,
      }],
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
      tabs: [{
        id: 'statusbar',
        title: 'Statusbar',
        lines: ['Space toggle · [ / ] reorder · Enter save · Esc discard'],
        toggles: context.statusbarModules,
      }],
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
    applyThemePreset(themeItem.value as ThemePresetName);
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

  return {message: 'Settings saved.'};
}
