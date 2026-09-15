import { useEffect, useState } from 'react';
import { useApsis } from '../state/store';

/**
 * The store's `revision`, sampled at most every `ms`.
 *
 * Panels that derive something expensive from the whole lead book must not key
 * off `revision` directly. It increments on every ingested event — roughly nine
 * times a second — and the Leads list rebuilds and sorts the entire book each
 * time it changes. At the default 4,892 leads that is survivable; at 60,000 it
 * measurably halved the frame rate, because an O(n log n) sort was running nine
 * times a second on the main thread alongside the render loop.
 *
 * Polling rather than subscribing is deliberate: it bounds the work by wall
 * clock regardless of how fast events arrive, so a burst cannot outrun it.
 *
 * Text that a human reads does not need to update at 60Hz. The 3D field still
 * reads `revision` directly, because that genuinely is per-frame.
 */
export function useThrottledRevision(ms = 500): number {
  const [revision, setRevision] = useState(() => useApsis.getState().revision);

  useEffect(() => {
    const id = window.setInterval(() => {
      const next = useApsis.getState().revision;
      setRevision((prev) => (prev === next ? prev : next));
    }, ms);
    return () => window.clearInterval(id);
  }, [ms]);

  return revision;
}
