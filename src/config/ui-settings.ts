import {join} from 'node:path';
import {z} from 'zod';
import {StateFile} from './model-preferences.js';
import {invalidateTheme} from './theme-palette.js';

/** Presentation preferences that renderers read live; `/settings` edits them and `~/.logox/ui-preferences.json` keeps them. */
export const toolTintChoices = ['none', 'subtle', 'standard'] as const;
export const emblemChoices = ['auto', 'small', 'large'] as const;
export const taglineChoices = ['fixed', 'rotate'] as const;
export const thinkingDisplayChoices = ['folded', 'preview', 'full'] as const;
export const diffLayoutChoices = ['auto', 'unified', 'compact'] as const;
export const notifyChoices = ['off', 'unfocused', 'always'] as const;
export const enterKeyChoices = ['send', 'newline'] as const;

export const uiPreferencesSchema = z.object({
  version: z.number().default(1),
  theme: z.string().default('logox-dark'),
  cursor: z.string().default('Block █'),
  toolTint: z.enum(toolTintChoices).default('standard'),
  startPage: z.boolean().default(true),
  emblem: z.enum(emblemChoices).default('auto'),
  tagline: z.enum(taglineChoices).default('fixed'),
  thinkingDisplay: z.enum(thinkingDisplayChoices).default('folded'),
  diffLayout: z.enum(diffLayoutChoices).default('auto'),
  notify: z.enum(notifyChoices).default('off'),
  enterKey: z.enum(enterKeyChoices).default('send'),
});
export type UiPreferencesData = z.infer<typeof uiPreferencesSchema>;
/** The render-relevant part; theme and cursor are applied by the application. */
export type UiSettings = Pick<UiPreferencesData, 'toolTint' | 'startPage' | 'emblem' | 'tagline' | 'thinkingDisplay' | 'diffLayout' | 'notify' | 'enterKey'>;
export const defaultUiSettings: Readonly<UiSettings> = Object.freeze({
  toolTint: 'standard', startPage: true, emblem: 'auto', tagline: 'fixed', thinkingDisplay: 'folded', diffLayout: 'auto', notify: 'off', enterKey: 'send',
});

let live: Readonly<UiSettings> = defaultUiSettings;
let revision = 0;
/** Live settings; renderers and key handlers read this, the application owns it. */
export function uiSettings(): Readonly<UiSettings> {return live;}
export function uiSettingsRevision(): number {return revision;}
/** Replaces the live settings; every cached layout is invalidated through the theme revision. */
export function applyUiSettings(next: Partial<UiSettings>): void {
  const merged = {...live, ...next};
  if ((Object.keys(merged) as (keyof UiSettings)[]).every(key => merged[key] === live[key])) return;
  live = Object.freeze(merged); revision++; invalidateTheme();
}
/** Fraction of the stock expanded-card tint each choice keeps. */
export const toolTintScale: Readonly<Record<UiSettings['toolTint'], number>> = {none: 0, subtle: 0.5, standard: 1};

/** `~/.logox/ui-preferences.json`, written atomically; saving applies the render-relevant values to the live settings. */
export class UiPreferences {
  private readonly file: StateFile<UiPreferencesData>;
  private data: UiPreferencesData = uiPreferencesSchema.parse({});
  private existed = false;
  constructor(homeDir: string) {
    this.file = new StateFile(join(homeDir, '.logox', 'ui-preferences.json'), uiPreferencesSchema);
  }
  get(): Readonly<UiPreferencesData> {return this.data;}
  /** True when a preference file was read (or written); false means everything is still the default. */
  get saved(): boolean {return this.existed;}
  /** Reads the saved file; a missing file keeps the defaults and applies them. */
  async load(): Promise<Readonly<UiPreferencesData>> {
    const saved = await this.file.read();
    if (saved) {this.data = saved; this.existed = true;}
    this.apply();
    return this.data;
  }
  async save(patch: Partial<UiPreferencesData>): Promise<void> {
    let next!: UiPreferencesData;
    await this.file.update(current => {
      next = uiPreferencesSchema.parse({...(current ?? this.data), ...patch});
      return next;
    });
    this.data = next; this.existed = true;
    this.apply();
  }
  private apply(): void {
    const {toolTint, startPage, emblem, tagline, thinkingDisplay, diffLayout, notify, enterKey} = this.data;
    applyUiSettings({toolTint, startPage, emblem, tagline, thinkingDisplay, diffLayout, notify, enterKey});
  }
}
