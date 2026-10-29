import {memo} from 'react';
import {Text} from 'ink';
import type {Activity} from '../../runtime/contracts.js';
import {cast} from '../../actors/ensemble.js';
import {Card} from '../components/card.js';
import {palette} from '../appearance/theme.js';
import {ownerColor, ownerSurface} from '../appearance/actor-style.js';
import {safeText} from '../terminal/text.js';

const labels = {queued: '排队', running: '运行中', waiting_input: '等待回答', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消'};
export const ActivityCard = memo(function ActivityCard({activity, expanded = false, hovered = false}: {activity: Activity; expanded?: boolean; hovered?: boolean}) {
  const isDream = activity.kind === 'anamnesis' || activity.ownerId === 'anamnesis', bright = expanded || hovered;
  const color = isDream ? palette.dreamText : ownerColor(activity.ownerId);
  const textColor = isDream ? palette.dreamText : bright ? color : palette.fg;
  const mutedColor = isDream ? palette.dreamMuted : palette.muted;
  const bg = isDream ? ownerSurface('anamnesis', bright) : activity.kind === 'actor' ? ownerSurface(activity.ownerId, bright) : undefined;
  const prefix = Object.hasOwn(cast, activity.ownerId) ? `${cast[activity.ownerId as keyof typeof cast].symbol} ` : '';
  const heading = activity.title.startsWith(prefix.trim()) ? activity.title : prefix + activity.title;
  return <Card title={`${heading} · ${labels[activity.status]}`} paddingY={0} color={color} {...(bg ? {bg} : {})}>
    <Text color={activity.status === 'failed' ? palette.error : textColor} {...(bg ? {backgroundColor: bg} : {})}>{safeText(activity.stage)}</Text>
    {expanded && activity.detail && <Text color={mutedColor} {...(bg ? {backgroundColor: bg} : {})}>{safeText(activity.detail)}</Text>}
  </Card>;
});
