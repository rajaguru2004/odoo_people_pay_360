import { useRef, useEffect, useState } from 'react';

/**
 * Returns a ref to attach to the dropdown trigger container and a `flipped`
 * boolean. When the dropdown opens and there isn't enough room below, flipped
 * is true — render the menu above (bottom-full mb-1) instead of below (top-full mt-1).
 */
export function useFlipDrop<T extends HTMLElement = HTMLDivElement>(
  isOpen: boolean,
  dropdownHeight = 240,
) {
  const ref = useRef<T>(null);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    if (!isOpen || !ref.current) { setFlipped(false); return; }
    const rect = ref.current.getBoundingClientRect();
    setFlipped(window.innerHeight - rect.bottom < dropdownHeight);
  }, [isOpen, dropdownHeight]);

  return { ref, flipped };
}
