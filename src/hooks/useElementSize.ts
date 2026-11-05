import { useState, useLayoutEffect, useRef } from "react";

interface Size {
  width: number;
  height: number;
}

export function useElementSize<T extends HTMLElement = HTMLDivElement>(): [
  (node: T | null) => void,
  Size
] {
  const [ref, setRef] = useState<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  useLayoutEffect(() => {
    if (!ref) return;

    observer.current = new ResizeObserver((entries) => {
      if (entries[0]) {
        const { width, height } = entries[0].contentRect;
        // A hidden sidebar reports zero size. Keep its tree mounted so that
        // expansion, selection and scroll state survive partition switches.
        if (width <= 0 || height <= 0) return;
        setSize({ width, height });
      }
    });

    observer.current.observe(ref);

    return () => {
      if (observer.current) {
        observer.current.disconnect();
      }
    };
  }, [ref]);

  return [setRef, size];
}
