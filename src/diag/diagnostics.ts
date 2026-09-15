/**
 * Performance diagnostics — instrumentation only.
 *
 * EVERYTHING HERE IS OFF BY DEFAULT. With no diagnostic URL parameter the flags
 * resolve to exactly the shipping configuration, the probe is never installed,
 * and no diagnostic code runs in a frame. This module exists to answer one
 * question the project could not otherwise answer — *is Apsis CPU-bound or
 * GPU-bound on the owner's M1* — and it answers it on the owner's hardware,
 * because no other machine available to this project has a GPU.
 *
 * Why the toggles are subtractive rather than a rewrite: the honest way to find
 * a bottleneck is to remove one suspect at a time and watch the frame time,
 * not to guess from a profile taken on a software rasterizer. Each flag removes
 * exactly one candidate cost and changes nothing else.
 *
 * URL parameters (all optional):
 *   ?diag=1      live overlay: fps, frame time, renderer CPU time, GPU time
 *   ?bench=1     walk the whole matrix automatically and print a table
 *   ?dpr=1       force devicePixelRatio (isolates fill rate from everything else)
 *   ?field=off   stop drawing the lead points (isolates sprite overdraw)
 *   ?core=off    stop drawing the Intelligence Core (isolates the raymarch)
 *   ?feed=off    stop the simulated event source (isolates the revision walk)
 *   ?anim=off    freeze ambient motion (reuses the reduced-motion path)
 *   ?fx=off      existing: disable the post pipeline
 *   ?leads=N     existing: book size
 */

import type * as THREE from 'three';

export interface DiagFlags {
  overlay: boolean;
  bench: boolean;
  /** Explicit devicePixelRatio, or null to use the shipping `[1, 2]` cap. */
  dpr: number | null;
  field: boolean;
  core: boolean;
  feed: boolean;
  anim: boolean;
}

function readFlags(): DiagFlags {
  if (typeof window === 'undefined') {
    return { overlay: false, bench: false, dpr: null, field: true, core: true, feed: true, anim: true };
  }
  const q = new URLSearchParams(window.location.search);
  const dprRaw = q.get('dpr');
  const dpr = dprRaw ? Number.parseFloat(dprRaw) : NaN;
  return {
    overlay: q.get('diag') === '1',
    bench: q.get('bench') === '1',
    dpr: Number.isFinite(dpr) && dpr > 0 ? Math.min(3, dpr) : null,
    // `off` is the only value that disables; anything else leaves it on, so a
    // typo degrades to the shipping configuration rather than to a silent hole.
    field: q.get('field') !== 'off',
    core: q.get('core') !== 'off',
    feed: q.get('feed') !== 'off',
    anim: q.get('anim') !== 'off',
  };
}

/** Read once at module load: these are URL values and cannot change without navigation. */
export const DIAG: DiagFlags = readFlags();

/** True when any diagnostic parameter is present — used to keep the probe out of normal runs. */
export const DIAG_ACTIVE =
  DIAG.overlay || DIAG.bench || DIAG.dpr !== null || !DIAG.field || !DIAG.core || !DIAG.feed || !DIAG.anim;

export interface Sample {
  fps: number;
  /** Wall-clock interval between frames — what the user actually experiences. */
  frameMs: number;
  /**
   * Synchronous time inside `renderer.render()`: scene traversal, matrix and
   * uniform updates, buffer uploads, draw-call submission. This is CPU work.
   */
  renderMs: number;
  /**
   * Everything in the frame that is not `render()` — useFrame callbacks, React,
   * and any time the main thread sits waiting on the GPU.
   */
  otherMs: number;
  /** True GPU execution time, when the driver exposes timer queries. */
  gpuMs: number | null;
  drawCalls: number;
  points: number;
  triangles: number;
}

interface Ring {
  frame: number[];
  render: number[];
  gpu: number[];
}

const RING = 180;
const ring: Ring = { frame: [], render: [], gpu: [] };
let renderAccum = 0;
let installed = false;
/**
 * Draw statistics accumulated ACROSS a frame.
 *
 * `renderer.info.render` resets on every `render()` call, and the post pipeline
 * makes several per frame — so sampling it from outside reports only whatever
 * the last pass happened to draw (a single full-screen triangle), which reads
 * as "1 draw call" for the busiest configuration in the app. Summing inside the
 * wrapper is the only way these numbers mean what they say.
 */
let callsAccum = 0;
let pointsAccum = 0;
let trisAccum = 0;
let lastCalls = 0;
let lastPoints = 0;
let lastTris = 0;

const push = (a: number[], v: number) => {
  a.push(v);
  if (a.length > RING) a.shift();
};

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/**
 * Wrap the renderer so each frame's CPU render cost is timed, and start a
 * frame-interval sampler.
 *
 * The CPU/GPU discrimination rests on the relationship between the two numbers
 * this produces. `render()` returns once the draw calls are *submitted*, not
 * once they are *executed*, so:
 *
 *   renderMs ≈ frameMs   → the main thread is the limit (CPU-bound)
 *   renderMs ≪ frameMs   → the frame is waiting on something else, and with
 *                          everything else toggled off that something is the GPU
 *
 * Where the driver exposes `EXT_disjoint_timer_query_webgl2`, gpuMs measures GPU
 * execution directly and the inference above is not needed. Chrome often
 * withholds it, so the app must not depend on it being there.
 */
export function installRenderProbe(gl: THREE.WebGLRenderer): void {
  if (installed || !DIAG_ACTIVE) return;
  installed = true;

  const original = gl.render.bind(gl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gl as any).render = (scene: never, camera: never) => {
    const t0 = performance.now();
    original(scene, camera);
    renderAccum += performance.now() - t0;
    callsAccum += gl.info.render.calls;
    pointsAccum += gl.info.render.points;
    trisAccum += gl.info.render.triangles;
  };

  const ctx = gl.getContext() as WebGL2RenderingContext;
  const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2');
  let query: WebGLQuery | null = null;

  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    push(ring.frame, now - last);
    push(ring.render, renderAccum);
    last = now;
    renderAccum = 0;
    // Carry the completed frame's totals before zeroing for the next one.
    if (callsAccum > 0) {
      lastCalls = callsAccum;
      lastPoints = pointsAccum;
      lastTris = trisAccum;
    }
    callsAccum = pointsAccum = trisAccum = 0;

    if (ext && ctx) {
      // One query in flight at a time; results land a frame or two later.
      if (query) {
        const available = ctx.getQueryParameter(query, ctx.QUERY_RESULT_AVAILABLE);
        const disjoint = ctx.getParameter(ext.GPU_DISJOINT_EXT);
        if (available && !disjoint) {
          push(ring.gpu, ctx.getQueryParameter(query, ctx.QUERY_RESULT) / 1e6);
          ctx.deleteQuery(query);
          query = null;
        } else if (disjoint) {
          ctx.deleteQuery(query);
          query = null;
        }
      }
      if (!query) {
        query = ctx.createQuery();
        if (query) ctx.beginQuery(ext.TIME_ELAPSED_EXT, query);
        requestAnimationFrame(() => {
          try { ctx.endQuery(ext.TIME_ELAPSED_EXT); } catch { /* context lost */ }
        });
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function readSample(): Sample {
  const frameMs = median(ring.frame);
  const renderMs = median(ring.render);
  return {
    fps: frameMs > 0 ? 1000 / frameMs : 0,
    frameMs,
    renderMs,
    otherMs: Math.max(0, frameMs - renderMs),
    gpuMs: ring.gpu.length ? median(ring.gpu) : null,
    drawCalls: lastCalls,
    points: lastPoints,
    triangles: lastTris,
  };
}

/** Discard warm-up frames so a measurement starts from a settled state. */
export function resetSamples(): void {
  ring.frame.length = 0;
  ring.render.length = 0;
  ring.gpu.length = 0;
}

/* ------------------------------------------------------------------ bench --- */

export interface BenchStep {
  label: string;
  query: string;
  /** What this step removes relative to the previous one. */
  isolates: string;
}

/**
 * The matrix, ordered so each step subtracts one suspect.
 *
 * Read the resulting table as differences, not absolutes: the drop between two
 * adjacent rows is the cost of the thing that row removed.
 */
export const BENCH_MATRIX: readonly BenchStep[] = [
  { label: 'baseline', query: '', isolates: 'everything on — the shipping configuration' },
  { label: 'fx=off', query: 'fx=off', isolates: 'post-processing (bloom + tone mapping)' },
  { label: 'fx=off dpr=1', query: 'fx=off&dpr=1', isolates: 'a quarter of the fragments' },
  { label: 'fx=off dpr=1 core=off', query: 'fx=off&dpr=1&core=off', isolates: 'the raymarched Core' },
  { label: 'fx=off dpr=1 field=off', query: 'fx=off&dpr=1&field=off', isolates: 'lead sprite overdraw' },
  { label: 'fx=off dpr=1 field=off core=off', query: 'fx=off&dpr=1&field=off&core=off', isolates: 'all heavy drawing — what remains is CPU' },
  { label: 'feed=off', query: 'feed=off', isolates: 'the event stream and its full-book revision walk' },
  { label: 'anim=off', query: 'anim=off', isolates: 'ambient animation' },
  { label: 'dpr=1 only', query: 'dpr=1', isolates: 'pixel count alone, effects still on' },
];

const KEY = 'apsis.bench';
const WARMUP_MS = 3500;
const SAMPLE_MS = 6000;

interface BenchRow extends Sample {
  label: string;
  isolates: string;
  leads: number;
  dpr: number;
}

/**
 * Walk the matrix by navigating, one configuration per page load.
 *
 * Navigation rather than live toggling because DPR and the post pipeline are
 * fixed at canvas creation; remounting the renderer mid-run would measure the
 * remount as much as the configuration.
 */
export function runBenchIfRequested(): void {
  if (!DIAG.bench || typeof window === 'undefined') return;

  const params = new URLSearchParams(window.location.search);
  const stepIndex = Number.parseInt(params.get('benchStep') ?? '0', 10) || 0;
  const leads = params.get('leads') ?? '';

  window.setTimeout(() => {
    resetSamples();
    window.setTimeout(() => {
      const rows: BenchRow[] = JSON.parse(sessionStorage.getItem(KEY) ?? '[]');
      const step = BENCH_MATRIX[stepIndex];
      rows.push({
        ...readSample(),
        label: step.label,
        isolates: step.isolates,
        leads: leads ? Number.parseInt(leads, 10) : 4892,
        dpr: window.devicePixelRatio,
      });
      sessionStorage.setItem(KEY, JSON.stringify(rows));

      const next = stepIndex + 1;
      if (next < BENCH_MATRIX.length) {
        const q = new URLSearchParams(BENCH_MATRIX[next].query);
        q.set('bench', '1');
        q.set('benchStep', String(next));
        if (leads) q.set('leads', leads);
        window.location.search = `?${q.toString()}`;
      } else {
        sessionStorage.removeItem(KEY);
        renderBenchReport(rows);
      }
    }, SAMPLE_MS);
  }, WARMUP_MS);
}

function renderBenchReport(rows: BenchRow[]): void {
  const head = ['config', 'fps', 'frame ms', 'render ms (CPU)', 'other ms', 'gpu ms', 'draws', 'isolates'];
  const body = rows.map((r) => [
    r.label,
    r.fps.toFixed(1),
    r.frameMs.toFixed(1),
    r.renderMs.toFixed(1),
    r.otherMs.toFixed(1),
    r.gpuMs === null ? 'n/a' : r.gpuMs.toFixed(1),
    String(r.drawCalls),
    r.isolates,
  ]);
  const text = [head, ...body].map((c) => c.join('\t')).join('\n');

  const el = document.createElement('div');
  el.setAttribute('data-bench-report', '');
  el.style.cssText =
    'position:fixed;inset:0;z-index:99999;background:#05050d;color:#e6e9f6;overflow:auto;' +
    'padding:24px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace';
  const machine = `leads=${rows[0]?.leads ?? '?'} dpr=${rows[0]?.dpr ?? '?'} ` +
    `window=${window.innerWidth}x${window.innerHeight} ua=${navigator.userAgent}`;
  el.innerHTML =
    `<h1 style="font:600 15px ui-sans-serif,system-ui;margin:0 0 4px">Apsis bench</h1>` +
    `<p style="color:#7d87a8;margin:0 0 16px">${machine}</p>` +
    `<table style="border-collapse:collapse">${[head, ...body]
      .map((cells, i) =>
        `<tr>${cells
          .map((c) =>
            `<${i === 0 ? 'th' : 'td'} style="text-align:left;padding:3px 14px 3px 0;` +
            `border-bottom:1px solid rgba(122,138,190,.16)">${c}</${i === 0 ? 'th' : 'td'}>`)
          .join('')}</tr>`)
      .join('')}</table>` +
    `<p style="color:#7d87a8;margin:16px 0 6px">Copy everything below and send it back:</p>` +
    `<textarea readonly style="width:100%;height:190px;background:#0e1020;color:#e6e9f6;` +
    `border:1px solid rgba(122,138,190,.3);border-radius:8px;padding:10px;font:inherit">` +
    `${machine}\n${text}</textarea>`;
  document.body.appendChild(el);
}
