// The compact composer body: prompt glyph, visible input lines with the selection fill, the expand button, and the
// one-line choice summary shown while a question owns the keyboard. Layout numbers are computed by `App`.
import {Box, Text} from 'ink';
import {palette} from '../appearance/theme.js';
import {clipLine} from '../terminal/text.js';
import {COMPOSER_EXPAND_LABEL, COMPOSER_EXPAND_PADDING} from './fullscreen-editor.js';
import {graphemes, inputViewport, type draftSelection} from './editor.js';

export interface ComposerLinesProps {
  editable: boolean;
  height: number;
  width: number;
  textWidth: number;
  view: ReturnType<typeof inputViewport>;
  selection: ReturnType<typeof draftSelection>;
  promptWidth: number;
  promptGlyph: string;
  promptColor: string;
  editingCustom: boolean;
  showExpandButton: boolean;
  expandHovered: boolean;
  choiceSummary: string;
}

export function ComposerLines({editable, height, width, textWidth, view: inputView, selection: inputSelection, promptWidth, promptGlyph, promptColor: composerPrompt,
  editingCustom, showExpandButton, expandHovered, choiceSummary}: ComposerLinesProps) {
  return <Box height={height} flexShrink={0} flexDirection="column" overflow="hidden">
      {editable ? inputView.lines.map((line, index) => <Box key={index} height={1} flexShrink={0}>
        <Box width={textWidth} overflow="hidden"><Text wrap="truncate" color={palette.composerFg}>
          {promptWidth > 0 && <Text color={editingCustom ? palette.user : composerPrompt} bold={!editingCustom}>{index === 0 ? promptGlyph : ' '.repeat(promptWidth)}</Text>}
          {(() => {
            if (!inputSelection || inputSelection.end <= line.start || inputSelection.start >= line.end) return line.text;
            const parts = graphemes(line.text), low = Math.max(0, inputSelection.start - line.start), high = Math.min(parts.length, inputSelection.end - line.start);
            return <>{parts.slice(0, low).join('')}<Text color={palette.selectionFg} backgroundColor={palette.selectionBg}>{parts.slice(low, high).join('')}</Text>{parts.slice(high).join('')}</>;
          })()}
        </Text></Box>
        {showExpandButton && index === 0 && <Text color={expandHovered ? palette.strong : palette.muted}>{' '.repeat(COMPOSER_EXPAND_PADDING + 1) + COMPOSER_EXPAND_LABEL + ' '.repeat(COMPOSER_EXPAND_PADDING)}</Text>}
      </Box>) : <Text color={palette.muted} wrap="truncate">{clipLine(choiceSummary, width)}</Text>}
    </Box>;
}
