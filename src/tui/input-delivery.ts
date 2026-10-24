import stringWidth from 'string-width';
import {clipLine} from './viewport.js';

export function inputDeliveryHint(width: number, queued: number, target: string | undefined, menu?: string): string {
  const badge = 'Queued ' + queued;
  const candidates = menu ? [badge + ' · ' + menu, badge] : [
    badge + ' · Enter Queue · ' + (target ? 'Ctrl+T Steer ' + target : 'Ctrl+N Select task'),
    badge + ' · Enter Queue · ' + (target ? '^T Steer' : '^N Select'),
    badge + ' · Enter Queue', badge, 'Q' + queued,
  ];
  if (menu) candidates.push('Q' + queued);
  return candidates.find(text => stringWidth(text) <= width) ?? clipLine(badge, width);
}
