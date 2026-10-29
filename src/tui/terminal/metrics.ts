import {useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {measureElement, type DOMElement} from 'ink';

/** App 的内容和终端尺寸变化都会提交布局；相同高度不安排额外渲染。 */
export function useContentHeight(ref: RefObject<DOMElement | null>): number {
  const [height, setHeight] = useState(0);
  const measured = useRef(0);
  useLayoutEffect(() => {
    const next = ref.current ? measureElement(ref.current).height : 0;
    // 在调用 setter 前比较，避免连续分片下测量通知再次加入 React 更新队列。
    if (next !== measured.current) {
      measured.current = next;
      setHeight(next);
    }
  });
  return height;
}
