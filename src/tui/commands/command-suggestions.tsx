import {Text} from 'ink';
import stringWidth from 'string-width';
import {ListFrame, listContentWidth} from '../components/list-frame.js';
import {palette} from '../appearance/theme.js';
import {safeText, clipLine} from '../terminal/text.js';
import {splitQueryMatch} from './query-match.js';

export interface SuggestionCommand {readonly name: string; readonly description: string; readonly tag?: string}
export interface CommandSuggestionsProps {
  readonly commands: readonly SuggestionCommand[];
  readonly selectedIndex: number;
  readonly columns: number;
  readonly query?: string;
  readonly title?: string;
  readonly holdFrom?: number;
  readonly maxVisible?: number;
  readonly showCounts?: boolean;
  readonly y?: number;
  readonly onPick?: ((index: number) => void) | undefined;
  readonly onWheelStep?: ((direction: 1 | -1) => void) | undefined;
}
export function suggestionWindow(length: number, selectedIndex: number, maxVisible = 5) {
  const count = Math.min(Math.max(0, length), 5, Math.max(1, Math.floor(maxVisible)));
  const selected = Math.max(0, Math.min(Math.max(0, length - 1), selectedIndex));
  const start = Math.max(0, Math.min(length - count, selected - Math.floor(count / 2)));
  return {start, count, selected};
}

export function CommandSuggestions({commands, selectedIndex, columns, query = '', title = 'Commands',
  maxVisible = 5, showCounts = true, y = 0, onPick, onWheelStep}: CommandSuggestionsProps) {
  const window = suggestionWindow(commands.length, selectedIndex, maxVisible);
  const start = window.start;
  if (!commands.length) return null;
  const contentWidth = listContentWidth(columns);
  const available = Math.max(0, contentWidth - 3);
  const longest = Math.max(...commands.map(command => stringWidth(safeText(command.name))));
  const nameBudget = Math.min(longest, available, Math.floor(contentWidth * 0.4));
  const rows = commands.slice(start, start + window.count).map((command, row) => {
    const active = start + row === window.selected;
    const name = safeText(command.name);
    const clipped = clipLine(name, nameBudget);
    const originalHit = splitQueryMatch(name, query);
    const hit = originalHit ? {
      before: clipped.slice(0, originalHit.before.length),
      match: clipped.slice(originalHit.before.length, originalHit.before.length + originalHit.match.length),
      after: clipped.slice(originalHit.before.length + originalHit.match.length),
    } : null;
    const nameColor = active ? palette.accent : palette.muted;
    const gap = Math.max(0, nameBudget - stringWidth(clipped)) + 2;
    const rest = Math.max(0, available - nameBudget - 2);
    // A bracketed argument hint takes the remaining budget before optional description text.
    const tag = command.tag && rest >= 2 ? `[${clipLine(safeText(command.tag), rest - 2)}]` : '';
    const description = clipLine(safeText(command.description), Math.max(0, rest - (tag ? stringWidth(tag) + 1 : 0)));
    return <Text key={start + row}><Text color={nameColor}>{active ? ' ❯ ' : '   '}</Text>
      {hit ? <><Text color={nameColor}>{hit.before}</Text><Text color={active ? palette.accent : palette.fg}>{hit.match}</Text><Text color={nameColor}>{hit.after}</Text></> : <Text color={nameColor}>{clipped}</Text>}
      {rest > 0 && <Text color={active ? palette.accent : palette.muted}>{' '.repeat(gap)}{tag}{tag && description ? ' ' : ''}{description}</Text>}
    </Text>;
  });
  const hiddenAbove = start, hiddenBelow = commands.length - start - window.count;
  const footer = showCounts && (hiddenAbove || hiddenBelow) ? `↑${hiddenAbove} · ↓${hiddenBelow}` : null;
  return <ListFrame title={`${title} · ${commands.length}`} columns={columns} rows={rows} footer={footer} y={y}
    onRowPick={index => onPick?.(start + index)} onWheelStep={onWheelStep}/>;
}
