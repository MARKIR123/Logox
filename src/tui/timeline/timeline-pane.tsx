// The timeline region of the screen: the splash or welcome text while the session is empty, otherwise the viewport rows
// (drawn here only when no terminal plane owns the rectangle). Presentation only; `App` decides what is shown and how tall.
import {Box, Text} from 'ink';
import type {Message} from '../../runtime/contracts.js';
import type {TerminalPlane} from '../terminal/terminal-plane.js';
import {splashLines} from '../appearance/emblem.js';
import {palette} from '../appearance/theme.js';
import {clipLine} from '../terminal/text.js';
import {layoutInput} from '../input/editor.js';
import {presentedSegments, railCell} from './row-presentation.js';
import type {SceneRow} from './scene.js';
import {selectionInViewport} from './selection.js';
import {viewport} from './viewport.js';

export interface TimelinePaneProps {
  splash: ReturnType<typeof splashLines> | undefined;
  welcome: Message | undefined;
  welcomeLines: ReturnType<typeof layoutInput>['lines'];
  plane: TerminalPlane | null;
  view: ReturnType<typeof viewport>;
  selection: ReturnType<typeof selectionInViewport>;
  width: number;
  timelineHeight: number;
}

export function TimelinePane({splash, welcome, welcomeLines, plane, view, selection, width, timelineHeight}: TimelinePaneProps) {
  return <Box height={timelineHeight} flexShrink={0} flexDirection="column" overflow="hidden">
      {splash ? splash.slice(0, timelineHeight).map((line, index) => <Box key={index} height={1} flexShrink={0} overflow="hidden">
        <Text wrap="truncate">{line.length ? line.map((segment, i) => <Text key={i} {...(segment.color ? {color: segment.color} : {})}
          {...(segment.bg ? {backgroundColor: segment.bg} : {})} bold={Boolean(segment.bold)} italic={Boolean(segment.italic)}>{segment.text}</Text>) : ' '}</Text>
      </Box>) : welcome ? welcomeLines.slice(0, timelineHeight).map((line, index) => <Box key={index} height={1} flexShrink={0} overflow="hidden">
        <Text color={welcome.systemTitle && index === 0 ? palette.accent : palette.muted} wrap="truncate">{clipLine(line.text, width) || ' '}</Text>
      </Box>) : !plane && view.rows.map((rawRow, index) => {
        const row = rawRow as SceneRow;
        const railSeg = railCell(row);
        const rail = row.gutterCols > 0 ? <Text {...(railSeg.color ? {color: railSeg.color} : {})} bold={Boolean(railSeg.bold)}>{railSeg.text}</Text> : null;
        return <Box key={index} height={1} flexShrink={0} overflow="hidden">
          {rail}
          <Text wrap="truncate">{presentedSegments(row, index, selection).map((seg, i) =>
            <Text key={i} color={seg.color ?? palette.fg} {...(seg.bg ?? row.bg ? {backgroundColor: seg.bg ?? row.bg} : {})} bold={Boolean(seg.bold)} italic={Boolean(seg.italic)} underline={Boolean(seg.underline)}>{seg.text}</Text>)}</Text>
        </Box>;
      })}
    </Box>;
}
