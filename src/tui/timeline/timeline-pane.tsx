// The timeline region of the screen: the splash or welcome text while the session is empty, otherwise the viewport rows
// (drawn here only when no terminal plane owns the rectangle). Presentation only; `App` decides what is shown and how tall.
// A plan sidebar docked beside the timeline is painted by the plane; without a plane it is drawn here, one line per row.
import {Box, Text} from 'ink';
import type {Message} from '../../runtime/contracts.js';
import type {PlaneSide, TerminalPlane} from '../terminal/terminal-plane.js';
import {splashLines} from '../appearance/emblem.js';
import {palette} from '../appearance/theme.js';
import {clipLine} from '../terminal/text.js';
import {layoutInput} from '../input/editor.js';
import {SideLine} from '../panels/plan-sidebar-view.js';
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
  /** The width of the timeline itself (the screen's width less a docked sidebar). */
  width: number;
  timelineHeight: number;
  side?: PlaneSide | undefined;
}

export function TimelinePane({splash, welcome, welcomeLines, plane, view, selection, width, timelineHeight, side}: TimelinePaneProps) {
  const drawn = !plane && !splash && !welcome;
  const count = drawn ? (side ? timelineHeight : view.rows.length) : 0;
  return <Box height={timelineHeight} flexShrink={0} flexDirection="column" overflow="hidden">
      {splash ? splash.slice(0, timelineHeight).map((line, index) => <Box key={index} height={1} flexShrink={0} overflow="hidden">
        <Text wrap="truncate">{line.length ? line.map((segment, i) => <Text key={i} {...(segment.color ? {color: segment.color} : {})}
          {...(segment.bg ? {backgroundColor: segment.bg} : {})} bold={Boolean(segment.bold)} italic={Boolean(segment.italic)}>{segment.text}</Text>) : ' '}</Text>
      </Box>) : welcome ? welcomeLines.slice(0, timelineHeight).map((line, index) => <Box key={index} height={1} flexShrink={0} overflow="hidden">
        <Text color={welcome.systemTitle && index === 0 ? palette.accent : palette.muted} wrap="truncate">{clipLine(line.text, width) || ' '}</Text>
      </Box>) : Array.from({length: count}, (_, index) => {
        const row = view.rows[index] as SceneRow | undefined;
        const railSeg = row ? railCell(row) : undefined;
        const rail = row && railSeg && row.gutterCols > 0 ? <Text {...(railSeg.color ? {color: railSeg.color} : {})} bold={Boolean(railSeg.bold)}>{railSeg.text}</Text> : null;
        const body = row ? <>{rail}
          <Text wrap="truncate">{presentedSegments(row, index, selection).map((seg, i) =>
            <Text key={i} color={seg.color ?? palette.fg} {...(seg.bg ?? row.bg ? {backgroundColor: seg.bg ?? row.bg} : {})} bold={Boolean(seg.bold)} italic={Boolean(seg.italic)} underline={Boolean(seg.underline)}>{seg.text}</Text>)}</Text></> : null;
        return <Box key={index} height={1} flexShrink={0} overflow="hidden">
          {side ? <Box width={side.x} flexShrink={0} overflow="hidden">{body}</Box> : body}
          {side ? <Box width={side.width} flexShrink={0} overflow="hidden"><SideLine line={side.lines[index]}/></Box> : null}
        </Box>;
      })}
    </Box>;
}
