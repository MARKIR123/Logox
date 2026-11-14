// The two-row footer: row 1 (status parts or notice text, right-docked actor pills, demo key hints) and row 2 (the
// notification line). Presentation only; `App` owns the layout plan, hover state and the strings.
import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import {palette} from '../appearance/theme.js';
import type {NoteSegment} from './notification-line.js';
import {ActorPills, type ActivePillItem} from './actor-pills.js';
import type {statusbarLayout} from './statusbar.js';

export interface FooterBarProps {
  height: number;
  width: number;
  /** A real status source exists (`getStatus`). */
  hasStatus: boolean;
  noticeInline: boolean;
  demoScene: boolean;
  notice: string;
  statusLeft: string;
  statusLeftColor: string;
  statusText: string;
  layout: ReturnType<typeof statusbarLayout>;
  pills: readonly ActivePillItem[];
  pillsWidth: number;
  hoveredPill: string | null;
  keys: string;
  note: readonly NoteSegment[];
}

export function FooterBar({height, width, hasStatus: getStatus, noticeInline, demoScene, notice, statusLeft, statusLeftColor, statusText: footerStatusText,
  layout: footerLayout, pills: activePills, pillsWidth, hoveredPill, keys: renderedFooterKeys, note: footerNote}: FooterBarProps) {
  const footerStatusParts = footerLayout.parts;
  return <Box height={height} flexShrink={0} flexDirection="column">
      <Box height={1} flexShrink={0} flexDirection="row">
        <Text color={statusLeftColor} wrap="truncate">{getStatus && !noticeInline
          ? footerStatusParts.map((part, index) => <Text key={index} color={part.color ?? statusLeftColor} {...(part.bold ? {bold: true} : {})} {...(part.backgroundColor ? {backgroundColor: part.backgroundColor} : {})}>{part.text}</Text>)
          : footerStatusText}</Text>
        {activePills.length > 0 ? <>
          <Text>{' '.repeat(Math.max(0, width - (getStatus && !noticeInline ? footerLayout.width : stringWidth(footerStatusText)) - pillsWidth))}</Text>
          <ActorPills pills={activePills} hoveredOwnerId={hoveredPill}/>
        </> : demoScene && !getStatus && !notice && stringWidth(statusLeft) + stringWidth(renderedFooterKeys) + 2 <= width ? <>
          <Text>{' '.repeat(width - stringWidth(statusLeft) - stringWidth(renderedFooterKeys))}</Text>
          <Text color={palette.muted}>{renderedFooterKeys}</Text>
        </> : null}
      </Box>
      {height > 1 && <Box height={1} flexShrink={0}><Text wrap="truncate">{footerNote.map((segment, index) =>
        <Text key={index} {...(segment.color ? {color: segment.color} : {})} {...(segment.bold ? {bold: true} : {})} {...(segment.italic ? {italic: true} : {})}>{segment.text}</Text>)}</Text></Box>}
    </Box>;
}
