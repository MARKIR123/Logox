import {useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {measureElement, type DOMElement} from 'ink';

/** Layout is committed on both App content and terminal size changes; an unchanged height schedules no extra render. */
export function useContentHeight(ref: RefObject<DOMElement | null>): number {
  const [height, setHeight] = useState(0);
  const measured = useRef(0);
  useLayoutEffect(() => {
    const next = ref.current ? measureElement(ref.current).height : 0;
    // Compare before calling the setter so consecutive measurement notifications do not re-enter the React update queue.
    if (next !== measured.current) {
      measured.current = next;
      setHeight(next);
    }
  });
  return height;
}
