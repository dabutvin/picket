/**
 * Tapping the tab you're already on: like iOS, the first tap goes back to the tab's top level
 * (closes an open photo, the Jump-to grid, selection mode), and a tap at the top level scrolls
 * back to the start. App calls `reselectTab`; screens subscribe with `useTabReselect`.
 */
import { useEffect, useRef } from 'react';

export type TabKey = 'review' | 'picks' | 'library' | 'settings';

const listeners = new Map<TabKey, Set<() => void>>();

export function reselectTab(tab: TabKey) {
  for (const fn of listeners.get(tab) ?? []) fn();
}

/** Run `onReselect` whenever `tab` is tapped while it is already the active tab. */
export function useTabReselect(tab: TabKey, onReselect: () => void) {
  const latest = useRef(onReselect);
  useEffect(() => {
    latest.current = onReselect;
  });
  useEffect(() => {
    const fn = () => latest.current();
    let set = listeners.get(tab);
    if (!set) listeners.set(tab, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }, [tab]);
}
