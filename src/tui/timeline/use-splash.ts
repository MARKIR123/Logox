// The start page: the splash drawn into the timeline while the session holds only its welcome message. Memoized exactly as
// before (welcome, size, roles, theme revision); the `Start page` setting off keeps the plain welcome text.
import {useMemo} from 'react';
import {createRequire} from 'node:module';
import type {Message} from '../../runtime/contracts.js';
import {uiSettings} from '../../config/ui-settings.js';
import type {ActorStyles} from '../appearance/actor-style.js';
import {splashLines, taglineFor} from '../appearance/emblem.js';
import {palette} from '../appearance/theme.js';
import {safeText} from '../terminal/text.js';

/** The package version for the splash; dist/src/tui/timeline/use-splash.js sits four levels below package.json. */
const APP_VERSION = (() => { try { return (createRequire(import.meta.url)('../../../../package.json') as {version?: string}).version; } catch { return undefined; } })();

export function useSplash({welcome, width, timelineHeight, roles, themeVersion}: {welcome: Message | undefined; width: number; timelineHeight: number; roles: ActorStyles; themeVersion: number}) {
  return useMemo(() => {
    // `Start page` off keeps the plain welcome text.
    if (!welcome || !uiSettings().startPage) return undefined;
    const lines = safeText(welcome.text).replace(/\t/g, '  ').split('\n');
    return splashLines({width, height: timelineHeight, title: welcome.systemTitle, info: lines, version: APP_VERSION,
      emblem: uiSettings().emblem, tagline: taglineFor(uiSettings().tagline),
      colors: {blue: roles.logox?.color ?? palette.accent, bone: palette.fg, title: palette.accent, muted: palette.muted}});
  }, [welcome, width, timelineHeight, roles, themeVersion]);
}
