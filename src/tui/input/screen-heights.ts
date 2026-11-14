// The vertical budget of the full-screen layout: login, picker, composer-side rows, then how the activity card, the docked
// question and the timeline share what is left. Pure arithmetic over measured values; `App` measures and draws.
import type {Activity, Interaction} from '../../runtime/contracts.js';
import type {CommandSurface} from '../../runtime/command-surface.js';
import type {LoginState} from '../../providers/login.js';

export function screenHeights({loginState, loginFolded, surface, screenRows, inputHeight, pendingHeight, hairlineHeight, footerHeight, menuHeight, demoScene, stage,
  activity, activityContentHeight, expanded, questionPanel, request, inlineRequest}: {
  loginState: LoginState | null; loginFolded: boolean; surface: CommandSurface | null; screenRows: number; inputHeight: number; pendingHeight: number;
  hairlineHeight: number; footerHeight: number; menuHeight: number; demoScene: boolean; stage: boolean; activity: Activity | undefined; activityContentHeight: number;
  expanded: boolean; questionPanel: Interaction | undefined; request: Interaction | undefined; inlineRequest: unknown;
}) {
  const loginHeight = loginState
    ? Math.min(
        screenRows,
        loginState.phase === 'wizard'
          ? loginFolded ? Math.min(4, screenRows) : Math.max(1, Math.min(24, screenRows - 2))
          : 8,
      )
    : 0;
  const groupedPicker = surface?.kind === 'picker' && new Set(surface.items.map(item => item.group).filter(Boolean)).size > 1;
  const pickerListRows = surface?.kind === 'picker' ? Math.min(6, surface.items.length) : 0;
  const pickerHasEffort = surface?.kind === 'picker' && surface.items.some(item => (item.effortLevels?.length ?? 0) > 0);
  const pickerHeight = surface?.kind === 'picker'
    ? Math.min(screenRows, (groupedPicker ? (pickerHasEffort ? 10 : 8) : (pickerHasEffort ? 7 : 5)) + pickerListRows)
    : 0;
  const fixedHeight = pickerHeight || (loginState && !loginFolded ? loginHeight : (loginFolded ? loginHeight : 0) + inputHeight + pendingHeight + hairlineHeight + footerHeight + menuHeight);
  const activityHeight = !loginState && !surface && !demoScene && !stage && activity ? Math.max(0, Math.min(activityContentHeight || (expanded ? 6 : 4), screenRows - fixedHeight)) : 0;
  const questionAvailable = Math.max(0, screenRows - fixedHeight - activityHeight);
  const questionHeight = questionPanel
    ? Math.min(questionAvailable, Math.min(22, Math.max(5, Math.floor(questionAvailable * 0.62))))
    : !loginState && !surface && !stage && (!demoScene || !inlineRequest) && request
      ? Math.max(0, Math.floor((screenRows - fixedHeight - activityHeight) * 0.6)) : 0;
  const timelineHeight = Math.max(0, screenRows - fixedHeight - activityHeight - questionHeight);
  return {loginHeight, pickerHeight, activityHeight, questionHeight, timelineHeight};
}
