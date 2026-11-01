import { useState } from 'react';
import type { Api } from '../lib/api';
import { Segmented } from '../components/Segmented';
import { SentScreen } from './SentScreen';
import { SkippedScreen } from './SkippedScreen';

type Shelf = 'sent' | 'skipped';
const SHELVES: { key: Shelf; label: string }[] = [
  { key: 'sent', label: 'Sent' },
  { key: 'skipped', label: 'Skipped' },
];

/** Kept across tab switches (the screen unmounts when another tab is shown). */
let lastShelf: Shelf = 'sent';

/** The archive: what went to Lightroom, and what was skipped. */
export function LibraryScreen({ api }: { api: Api }) {
  const [shelf, setShelf] = useState<Shelf>(lastShelf);
  const change = (s: Shelf) => {
    lastShelf = s;
    setShelf(s);
  };
  const toggle = <Segmented options={SHELVES} value={shelf} onChange={change} testIDPrefix="library" />;
  // `key` so switching resets the grid's list and selection.
  return shelf === 'sent' ? (
    <SentScreen key="sent" api={api} title="Library" headerExtra={toggle} />
  ) : (
    <SkippedScreen key="skipped" api={api} title="Library" headerExtra={toggle} />
  );
}
