import { useEffect, useState } from 'react';
import { DIAG } from '../diag/diagnostics';

/**
 * `prefers-reduced-motion`, live.
 *
 * Subscribed rather than read once: the setting can change mid-session (macOS
 * exposes it as a toggle), and a value sampled at mount would leave the field
 * spinning for someone who just asked it to stop.
 *
 * What honouring it means here is specific. It does NOT mean freezing the app —
 * leads must still travel when their score changes, or the visualization stops
 * telling the truth. It means removing motion that carries no information:
 * the ambient rotation of the field, the Core's breathing, the pulse on busy
 * agent nodes. Score-driven travel is shortened, not removed, so a lead still
 * visibly relocates rather than teleporting.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && 'matchMedia' in window
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // `?anim=off` routes through the reduced-motion path rather than adding a
  // second set of branches to every animated component: it is already the
  // tested, correct way to say "remove motion that carries no information".
  return reduced || !DIAG.anim;
}
