// The pending-message rows directly above the composer (`Queued · Send now  ×`). Layout and hit regions come from
// `pendingRowLayout`; `App` computes which rows are shown and which control the pointer is over.
import {Box, Text} from 'ink';
import type {PendingInput} from '../../runtime/contracts.js';
import type {ActorStyles} from '../appearance/actor-style.js';
import {palette} from '../appearance/theme.js';
import {pendingRowLayout} from './input-delivery.js';

export interface PendingRowsProps {
  shown: readonly PendingInput[];
  height: number;
  width: number;
  currentView: string;
  roles: ActorStyles;
  hover: {id: string; control: 'send' | 'discard'} | null;
  windowColor: string;
}

export function PendingRows({shown, height, width, currentView, roles, hover: pendingHover, windowColor}: PendingRowsProps) {
  return <Box height={height} flexShrink={0} flexDirection="column" overflow="hidden">
      {shown.map(item => {
        const row = pendingRowLayout(width, item.text, item.ownerId === currentView ? undefined : roles[item.ownerId]?.name ?? item.ownerId, !!item.restored);
        const hover = (control: 'send' | 'discard') => pendingHover?.id === item.id && pendingHover.control === control;
        return <Box key={item.id} height={1} flexShrink={0} overflow="hidden"><Text wrap="truncate">
          <Text color={palette.muted}>{row.left + ' '.repeat(row.gap) + row.badge}</Text>
          {row.send && <Text color={hover('send') ? windowColor : palette.fg} bold={hover('send')} underline={hover('send')}>{row.send.text}</Text>}
          {row.send && row.discard && <Text>{'  '}</Text>}
          {row.discard && <Text color={hover('discard') ? windowColor : palette.muted} bold={hover('discard')}>{row.discard.text}</Text>}
        </Text></Box>;
      })}
    </Box>;
}
