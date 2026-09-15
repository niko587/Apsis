/**
 * Graceful degradation when the Universe cannot render (§21, §28 Q12).
 *
 * "3D must enhance the experience, not make the application unusable."
 *
 * Without this, a machine with no WebGL — locked-down enterprise browser, GPU
 * blocklist, remote desktop, `--disable-gpu` — gets an uncaught
 * `THREE.WebGLRenderer: Error creating WebGL context` and a silent black
 * rectangle. The rest of Apsis does keep working, because every number the
 * Universe shows is also published as DOM. But nothing tells the user that, so
 * the product looks broken rather than degraded.
 *
 * Two layers, because they catch different failures:
 *   1. A capability probe, so the common case never throws at all.
 *   2. An error boundary, for context loss and driver faults that only surface
 *      once rendering is under way.
 */

import { Component, useMemo, type ErrorInfo, type ReactNode } from 'react';

/** Can this browser give us a WebGL context at all? Probed once, cheaply. */
export function detectWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl');
    if (!gl) return false;
    // Release it immediately — holding a throwaway context costs a GPU slot, and
    // browsers cap how many a page may have.
    const lose = (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context');
    lose?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function Fallback({ reason }: { reason: string }) {
  return (
    <div className="universe-fallback" role="status">
      <h2>Lead Universe unavailable</h2>
      <p>{reason}</p>
      <p className="universe-fallback-hint">
        Everything the Universe shows is also in the panels on the right — the
        Leads list carries the same leads in the same order, closest to a booked
        appointment first, and is fully keyboard navigable.
      </p>
    </div>
  );
}

interface Props {
  children: ReactNode;
}
interface State {
  failed: boolean;
}

class RenderBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Logged, not swallowed. A silently degraded 3D layer is how a real GPU
    // regression survives to production looking like a design choice.
    console.error('Universe render failed; falling back to the DOM view.', error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <Fallback reason="The 3D view stopped rendering — most often a lost GPU context." />
      );
    }
    return this.props.children;
  }
}

export function UniverseBoundary({ children }: Props) {
  const supported = useMemo(() => detectWebGL(), []);

  if (!supported) {
    return (
      <Fallback reason="This browser has no WebGL context available, so the 3D view cannot start." />
    );
  }
  return <RenderBoundary>{children}</RenderBoundary>;
}
