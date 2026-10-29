import type {CommandSuggestion} from './completion.js';
import {CommandSuggestions} from './command-suggestions.js';

/** Reserve the same title, option and hidden-count rows the shared menu renders. */
export function commandMenuLayout(itemCount: number, availableRows: number): {count: number; height: number; showCounts: boolean} {
  let count = Math.max(0, Math.min(5, itemCount, availableRows - 1));
  const showCounts = availableRows >= 3;
  if (showCounts && itemCount > count) count = Math.min(count, Math.max(0, availableRows - 2));
  return {count, height: count > 0 ? 1 + count + (showCounts && itemCount > count ? 1 : 0) : 0, showCounts};
}

/** Connect completion data and execution to the shared command-suggestion view. */
export function CommandMenu({items, selected, width, query = '', maxVisible = 5, showCounts = true, y = 0, onPick, onWheelStep}: {
  items: readonly CommandSuggestion[]; selected: number; width: number;
  query?: string; maxVisible?: number; showCounts?: boolean; y?: number;
  onPick?: ((index: number) => void) | undefined;
  onWheelStep?: ((direction: 1 | -1) => void) | undefined;
}) {
  const title = items.every(item => item.label.startsWith('@')) ? 'Actors'
    : items.every(item => item.kind === 'argument') ? 'Arguments' : 'Commands';
  return <CommandSuggestions commands={items.map(item => ({name: item.label, description: item.description}))}
    selectedIndex={selected} columns={width} query={query} maxVisible={maxVisible} showCounts={showCounts} y={y} title={title}
    onPick={onPick} onWheelStep={onWheelStep}/>;
}
