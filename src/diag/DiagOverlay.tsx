/**
 * Live diagnostic readout. Rendered only under `?diag=1`.
 *
 * Deliberately plain DOM in a corner: it must not become another thing whose
 * cost has to be accounted for. It samples on an interval rather than per
 * frame, for the same reason the rail panels do.
 */

import { useEffect, useState } from 'react';
import { DIAG, readSample, type Sample } from './diagnostics';

export function DiagOverlay() {
  const [s, setS] = useState<Sample | null>(null);

  useEffect(() => {
    if (!DIAG.overlay) return;
    const id = window.setInterval(() => setS(readSample()), 500);
    return () => window.clearInterval(id);
  }, []);

  if (!DIAG.overlay || !s) return null;

  const off = [
    !DIAG.field && 'field',
    !DIAG.core && 'core',
    !DIAG.feed && 'feed',
    !DIAG.anim && 'anim',
    DIAG.dpr !== null && `dpr=${DIAG.dpr}`,
  ].filter(Boolean);

  // The verdict line. `render()` returns on submission, not completion, so a
  // frame that is mostly NOT render() is a frame spent somewhere else — and
  // with the drawing toggles off, that somewhere is the GPU.
  const cpuShare = s.frameMs > 0 ? s.renderMs / s.frameMs : 0;
  const verdict =
    s.gpuMs !== null
      ? s.gpuMs > s.renderMs ? 'GPU-dominated (timer query)' : 'CPU-dominated (timer query)'
      : cpuShare > 0.6
        ? 'CPU-dominated: most of the frame is inside render()'
        : cpuShare < 0.25
          ? 'not CPU-bound in render(): frame is spent waiting or in other JS'
          : 'mixed';

  return (
    <div
      style={{
        position: 'fixed',
        left: 12,
        top: 66,
        zIndex: 40,
        background: 'rgba(5,5,13,0.82)',
        border: '1px solid rgba(122,138,190,0.28)',
        borderRadius: 9,
        padding: '9px 11px',
        font: '11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#e6e9f6',
        pointerEvents: 'none',
        minWidth: 232,
      }}
    >
      <div style={{ color: '#8f6bff', letterSpacing: '0.12em', marginBottom: 4 }}>DIAGNOSTICS</div>
      <div>{s.fps.toFixed(1)} fps · {s.frameMs.toFixed(1)} ms/frame</div>
      <div>render() CPU · {s.renderMs.toFixed(2)} ms ({(cpuShare * 100).toFixed(0)}%)</div>
      <div>other · {s.otherMs.toFixed(2)} ms</div>
      <div>gpu · {s.gpuMs === null ? 'timer query unavailable' : `${s.gpuMs.toFixed(2)} ms`}</div>
      <div style={{ color: '#7d87a8' }}>
        {s.drawCalls} draws · {s.points.toLocaleString()} pts · {s.triangles.toLocaleString()} tris
      </div>
      <div style={{ color: '#7d87a8' }}>dpr {window.devicePixelRatio}{off.length ? ` · off: ${off.join(' ')}` : ''}</div>
      <div style={{ marginTop: 5, color: '#2fe08a', whiteSpace: 'normal', maxWidth: 232 }}>{verdict}</div>
    </div>
  );
}
