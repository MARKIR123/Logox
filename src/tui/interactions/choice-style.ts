import stringWidth from 'string-width';
import {palette} from '../appearance/theme.js';
import {toggleColor, toggleMarker} from '../components/toggle-marker.js';

export interface QuestionDraft {questionIndex: number; selected: number; text: string; error: string; checked?: readonly number[]}

/** Focus, committed checks and ordinary text keep distinct semantic colors. */
export function choiceStyle(selected: boolean, accent = palette.accent, textColor = palette.fg, mutedColor = palette.muted, checked?: boolean) {
  const marked = checked ?? selected;
  const marker = (selected ? '❯ ' : '  ') + toggleMarker(marked) + ' ';
  const indent = stringWidth(marker), multiColor = toggleColor(marked, selected);
  return {marker, indent, markerColor: checked !== undefined ? multiColor : marked ? palette.accent : mutedColor,
    color: checked !== undefined ? multiColor : selected ? accent : textColor,
    descriptionColor: checked !== undefined ? multiColor : selected ? accent : mutedColor};
}
