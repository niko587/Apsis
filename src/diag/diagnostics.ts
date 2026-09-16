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
 *
 * Round 3 (interaction / jank — a median cannot see either):
 *   ?jank=1      frame-time distribution, long tasks, input latency, spans
 *   ?sweep=1     the same, while a scripted pointer sweep drives hover/raycast
 *   ?sweep=drag  the same, while a scripted DRAG drives OrbitControls
 *   ?seconds=N   sampling window (default 10)
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

/**
 * True when any diagnostic parameter is present — used to keep the probe out of
 * normal runs. Computed from the URL rather than from `PROBE` (declared at the
 * foot of this file) so module initialisation order stays safe.
 */
export const DIAG_ACTIVE =
  DIAG.overlay ||
  DIAG.bench ||
  DIAG.dpr !== null ||
  !DIAG.field ||
  !DIAG.core ||
  !DIAG.feed ||
  !DIAG.anim ||
  (typeof window !== 'undefined' &&
    (() => {
      const q = new URLSearchParams(window.location.search);
      return q.get('probe') === '1' || q.get('jank') === '1' || q.has('sweep') || q.get('drag') === '1';
    })());

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
let probedRenderer: THREE.WebGLRenderer | null = null;

export function installRenderProbe(gl: THREE.WebGLRenderer): void {
  if (installed || !DIAG_ACTIVE) return;
  installed = true;
  probedRenderer = gl;

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

  // WebGL2 fence: the closest JS can get to "the GPU finished this frame".
  // Chrome withholds EXT_disjoint_timer_query_webgl2 and WebKit never shipped
  // it, so a polled fence is the only cross-browser GPU-completion signal.
  let fence: WebGLSync | null = null;
  let fenceAt = 0;

  let last = performance.now();
  const tick = (scheduled?: number) => {
    const now = performance.now();
    if (scheduled !== undefined) noteRafLateness(scheduled);

    if (typeof ctx.fenceSync === 'function') {
      if (fence) {
        const st = ctx.clientWaitSync(fence, 0, 0);
        if (st === ctx.ALREADY_SIGNALED || st === ctx.CONDITION_SATISFIED) {
          noteGpuFence(now - fenceAt);
          ctx.deleteSync(fence);
          fence = null;
        }
      }
      if (!fence) {
        fence = ctx.fenceSync(ctx.SYNC_GPU_COMMANDS_COMPLETE, 0);
        fenceAt = now;
      }
    }
    push(ring.frame, now - last);
    push(ring.render, renderAccum);
    // Round 3: the full distribution, not just the ring's median.
    noteFrame(now - last);
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

/* ------------------------------------------------- round 3: jank probes --- */

/**
 * Round 3 exists because round 2's table was misleading in a specific,
 * instructive way: on the owner's M1 all nine configurations reported an
 * identical 58.8 fps / 17.0 ms — including `field=off`, which removes the
 * entire lead field. A scene whose frame time does not change when you stop
 * drawing 4,892 sprites is not a scene that is struggling to draw. The median
 * was simply pinned to vsync, and a median cannot see jank.
 *
 * So these probes measure the things a median hides: the tail of the frame-time
 * distribution, main-thread long tasks, and the cost of the specific code paths
 * that run during interaction. Frame times from the measuring machine remain
 * meaningless (software rasterizer), but **span durations are pure JavaScript
 * and do transfer** — `ingest`, the `useFrame` walk and `Points.raycast` cost
 * what they cost on any comparable CPU.
 */

/** Deep instrumentation. Off unless explicitly asked for; see PROBE below. */
export const PROBE =
  typeof window !== 'undefined' &&
  (() => {
    const q = new URLSearchParams(window.location.search);
    // `sweep` accepts a value (`1` or `drag`), so presence is what counts —
    // testing for '1' silently dropped `?sweep=drag` on the floor.
    return q.get('probe') === '1' || q.get('jank') === '1' || q.has('sweep') || q.get('drag') === '1';
  })();

export const SWEEP =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('sweep');

export interface SpanStat {
  count: number;
  totalMs: number;
  maxMs: number;
}

const spans = new Map<string, SpanStat>();
const counters = new Map<string, number>();
/** Every frame interval in the sampling window — the whole distribution, not a summary. */
let frameLog: number[] = [];
let longTasks: { count: number; totalMs: number; maxMs: number } = { count: 0, totalMs: 0, maxMs: 0 };
/**
 * Whether `observe({entryTypes:['longtask']})` actually succeeded.
 *
 * Correctness defect found in round 4: Safari implements `PerformanceObserver`
 * but NOT the `longtask` entry type, so the observer throws and the counters
 * stay at zero — which printed as "0 long tasks" and reads as "no jank" when it
 * means "cannot see jank". A measurement that cannot fail is not a measurement.
 */
let longTaskSupported = false;
let pointerEvents = 0;
let logging = false;

/** Record one occurrence of a named span. Call sites are guarded by PROBE. */
export function span(name: string, ms: number): void {
  const s = spans.get(name);
  if (s) {
    s.count++;
    s.totalMs += ms;
    if (ms > s.maxMs) s.maxMs = ms;
  } else {
    spans.set(name, { count: 1, totalMs: ms, maxMs: ms });
  }
}

export function bump(name: string, n = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + n);
}

export function notePointerEvent(): void {
  if (PROBE) pointerEvents++;
}

/**
 * Long tasks are the direct measure of "the page stopped responding for a
 * moment". A 60 fps median with a 200 ms long task every few seconds is
 * exactly what "difficult to use" feels like, and exactly what an average
 * cannot show.
 */
export function installLongTaskObserver(): void {
  if (!PROBE || typeof PerformanceObserver === 'undefined') return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.count++;
        longTasks.totalMs += entry.duration;
        if (entry.duration > longTasks.maxMs) longTasks.maxMs = entry.duration;
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
    longTaskSupported = true;
  } catch {
    longTaskSupported = false; // Safari: reported explicitly, never as zero.
  }
}

export function startJankLog(): void {
  frameLog = [];
  spans.clear();
  counters.clear();
  longTasks = { count: 0, totalMs: 0, maxMs: 0 };
  pointerEvents = 0;
  logging = true;
}

export function noteFrame(dt: number): void {
  if (logging) frameLog.push(dt);
}

export interface Distribution {
  frames: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
  over20: number;
  over33: number;
  over50: number;
  over100: number;
}

export function distribution(): Distribution {
  const a = [...frameLog].sort((x, y) => x - y);
  const n = a.length;
  const at = (q: number) => (n ? a[Math.min(n - 1, Math.floor(n * q))] : 0);
  return {
    frames: n,
    mean: n ? a.reduce((p, c) => p + c, 0) / n : 0,
    median: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: n ? a[n - 1] : 0,
    over20: frameLog.filter((d) => d > 20).length,
    over33: frameLog.filter((d) => d > 33).length,
    over50: frameLog.filter((d) => d > 50).length,
    over100: frameLog.filter((d) => d > 100).length,
  };
}

export function jankReport(seconds: number) {
  return {
    distribution: distribution(),
    longTasks: longTaskSupported ? longTasks : null,
    pointerEventsPerSec: pointerEvents / seconds,
    spans: [...spans.entries()]
      .map(([name, s]) => ({
        name,
        count: s.count,
        perSec: +(s.count / seconds).toFixed(1),
        meanMs: +(s.totalMs / s.count).toFixed(3),
        maxMs: +s.maxMs.toFixed(2),
        totalMs: +s.totalMs.toFixed(1),
        shareOfWallClock: +((s.totalMs / (seconds * 1000)) * 100).toFixed(1),
      }))
      .sort((a, b) => b.totalMs - a.totalMs),
    counters: Object.fromEntries(counters),
  };
}

/**
 * Scripted pointer sweep.
 *
 * The owner's complaint is about *interacting*, and round 2 measured an idle
 * page — which is the likeliest reason it saw nothing. This drives synthetic
 * `pointermove` events across the canvas on a repeatable path, so the pointer
 * cost is measured the same way twice instead of depending on how someone
 * happened to wave the mouse. R3F listens to DOM pointer events, so these
 * travel the identical code path a human cursor does.
 */
export function runPointerSweep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return resolve();
    const rect = canvas.getBoundingClientRect();
    const t0 = performance.now();
    const step = () => {
      const t = performance.now() - t0;
      if (t >= durationMs) return resolve();
      // Lissajous path: covers the disc, crosses the dense rim and the centre,
      // and never repeats a straight line the raycaster could get lucky on.
      const u = t / 1000;
      const x = rect.left + rect.width * (0.5 + 0.42 * Math.sin(u * 1.7));
      const y = rect.top + rect.height * (0.5 + 0.38 * Math.sin(u * 2.3));
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        }),
      );
      notePointerEvent();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * `?jank=1` — sample the frame-time distribution, long tasks and code-path
 * spans, then print them. `?sweep=1` does the same while driving a scripted
 * pointer sweep over the canvas, which is the configuration that matters:
 * round 2 measured an idle page, and the owner's complaint is about
 * *interacting* with it.
 */
export function runJankIfRequested(): void {
  if (typeof window === 'undefined') return;
  const q = new URLSearchParams(window.location.search);
  if (q.get('jank') !== '1' && !q.has('sweep') && q.get('drag') !== '1') return;

  const seconds = Number.parseFloat(q.get('seconds') ?? '10') || 10;
  const drag = q.get('sweep') === 'drag' || q.get('drag') === '1';
  installLongTaskObserver();
  installEventTimingObserver();

  // Settle first: shader compile and the initial seed are not what we are
  // measuring, and they would dominate the tail if included.
  window.setTimeout(() => {
    startJankLog();
    resetInputLatency();
    resetPresentation();
    const mode = drag ? 'DRAG SWEEP (orbiting)' : SWEEP ? 'POINTER SWEEP (interacting)' : 'idle';
    const done = () => renderJankReport(jankReport(seconds), mode);
    if (drag) runDragSweep(seconds * 1000).then(done);
    else if (SWEEP) runPointerSweep(seconds * 1000).then(done);
    else window.setTimeout(done, seconds * 1000);
  }, 3500);
}

function renderJankReport(r: ReturnType<typeof jankReport>, mode: string): void {
  const d = r.distribution;
  const lt = r.longTasks;
  const lines: string[] = [];
  const q = new URLSearchParams(window.location.search);
  lines.push(
    `mode=${mode} leads=${q.get('leads') ?? '4892'} ` +
      `fx=${q.get('fx') ?? 'on'} dpr=${window.devicePixelRatio} ` +
      `window=${window.innerWidth}x${window.innerHeight}`,
  );
  lines.push(`ua=${navigator.userAgent}`);
  const c = readCapabilities(probedRenderer ?? undefined);
  lines.push(`BUILD MODE = ${c.buildMode.toUpperCase()}   (no longer inferred from the port)`);
  lines.push(
    `capabilities: longtask=${c.longtask ? 'yes' : 'NO'} eventTiming=${c.eventTiming ? 'yes' : 'NO'} ` +
      `gpuTimerQuery=${c.timerQuery ? 'yes' : 'NO'} fenceSync=${c.fenceSync ? 'yes' : 'NO'}`,
  );
  lines.push(`gl: ${c.webglVersion} | renderer: ${c.webglRenderer}`);
  const backdropOff = document.documentElement.classList.contains('diag-no-backdrop');
  const overlayOff = document.documentElement.classList.contains('diag-no-overlay');
  lines.push(`css: backdrop-filter=${backdropOff ? 'DISABLED (diag)' : 'on'} overlays=${overlayOff ? 'HIDDEN (diag)' : 'on'}`);
  lines.push('');
  const pr = presentation();
  lines.push('PRESENTATION PATH (as close as JS can get; see notes)');
  lines.push(
    `  rAF lateness      median=${pr.rafLateness.median.toFixed(1)}ms p95=${pr.rafLateness.p95.toFixed(1)}ms ` +
      `max=${pr.rafLateness.max.toFixed(1)}ms  (n=${pr.rafLateness.n})`,
  );
  lines.push(
    pr.gpuFence.n === 0
      ? '  GPU fence         unavailable (no WebGL2 fenceSync)'
      : `  GPU fence         median=${pr.gpuFence.median.toFixed(1)}ms p95=${pr.gpuFence.p95.toFixed(1)}ms ` +
        `max=${pr.gpuFence.max.toFixed(1)}ms  (n=${pr.gpuFence.n})`,
  );
  lines.push(
    pr.inputToSubmit.n === 0
      ? '  input->submit     no samples'
      : `  input->submit     median=${pr.inputToSubmit.median.toFixed(1)}ms p95=${pr.inputToSubmit.p95.toFixed(1)}ms ` +
        `max=${pr.inputToSubmit.max.toFixed(1)}ms  (n=${pr.inputToSubmit.n})`,
  );
  lines.push('  NOTE: true presentation time (pixels on glass) is NOT observable');
  lines.push('  from JavaScript in Safari. No frame-timing API, no GPU timer query.');
  lines.push('  Compositing — including backdrop-filter over the canvas — happens');
  lines.push('  after rAF returns and is measured by NONE of the above.');
  lines.push('');
  lines.push('FRAME TIME DISTRIBUTION (ms)');
  lines.push(
    `  frames=${d.frames}  mean=${d.mean.toFixed(1)}  median=${d.median.toFixed(1)}  ` +
      `p95=${d.p95.toFixed(1)}  p99=${d.p99.toFixed(1)}  max=${d.max.toFixed(1)}`,
  );
  lines.push(
    `  >20ms=${d.over20}  >33ms=${d.over33}  >50ms=${d.over50}  >100ms=${d.over100}` +
      `   (${d.frames ? ((d.over33 / d.frames) * 100).toFixed(1) : '0'}% of frames over 33ms)`,
  );
  lines.push('');
  lines.push('LONG TASKS (main thread >=50ms)');
  lines.push(
    lt === null
      ? '  LONGTASK OBSERVER UNSUPPORTED in this browser — this is NOT "zero long tasks".' +
        '\n  Safari has PerformanceObserver but not the longtask entry type; main-thread' +
        '\n  blocking is simply invisible here. Use Web Inspector > Timelines > Rendering Frames.'
      : `  count=${lt.count}  total=${lt.totalMs.toFixed(0)}ms  max=${lt.maxMs.toFixed(0)}ms`,
  );
  lines.push('');
  const il = inputLatency();
  lines.push('INPUT LATENCY (Event Timing API — the direct measure of "feels laggy")');
  lines.push(
    !il.supported
      ? '  PerformanceObserver unsupported in this browser'
      : il.samples === 0
        ? '  no qualifying input events (>16ms) recorded — inputs were handled promptly'
        : `  samples=${il.samples}  delay median=${il.delayMedian.toFixed(1)}ms  ` +
          `p95=${il.delayP95.toFixed(1)}ms  max=${il.delayMax.toFixed(1)}ms  ` +
          `| input->paint p95=${il.durationP95.toFixed(1)}ms max=${il.durationMax.toFixed(1)}ms`,
  );
  lines.push('');
  lines.push(`POINTER  events/sec=${r.pointerEventsPerSec.toFixed(1)}`);
  lines.push('');
  lines.push('CODE PATH SPANS (pure JavaScript — these transfer between machines)');
  lines.push('  name                 count   /sec    mean ms    max ms   total ms   % wall');
  for (const s of r.spans) {
    lines.push(
      `  ${s.name.padEnd(20)} ${String(s.count).padStart(5)} ${String(s.perSec).padStart(6)} ` +
        `${s.meanMs.toFixed(3).padStart(10)} ${s.maxMs.toFixed(2).padStart(9)} ` +
        `${s.totalMs.toFixed(1).padStart(10)} ${s.shareOfWallClock.toFixed(1).padStart(7)}`,
    );
  }
  lines.push('');
  lines.push('COUNTERS');
  for (const [k, v] of Object.entries(r.counters)) lines.push(`  ${k} = ${v.toLocaleString()}`);
  const text = lines.join('\n');

  const el = document.createElement('div');
  el.setAttribute('data-jank-report', '');
  el.style.cssText =
    'position:fixed;inset:0;z-index:99999;background:#05050d;color:#e6e9f6;overflow:auto;' +
    'padding:22px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace';
  const pre = document.createElement('pre');
  pre.textContent = text;
  pre.style.cssText = 'margin:0 0 14px;white-space:pre-wrap';
  const ta = document.createElement('textarea');
  ta.readOnly = true;
  ta.value = text;
  ta.style.cssText =
    'width:100%;height:230px;background:#0e1020;color:#e6e9f6;border:1px solid rgba(122,138,190,.3);' +
    'border-radius:8px;padding:10px;font:inherit';
  el.append(pre, ta);
  document.body.appendChild(el);
}

/* ------------------------------------------- round 3b: input latency --- */

/**
 * Event Timing API — the instrument for "it feels laggy even though the frame
 * rate looks fine".
 *
 * `longtask` says the main thread was blocked; it does not say the user waited.
 * Event Timing measures the wait directly: `processingStart - startTime` is how
 * long an input sat in the queue before any handler ran, and `duration` spans
 * input to the next paint. A page can hold a 60 fps median and still deliver
 * 150 ms input delay, which is exactly the shape of the owner's complaint —
 * smooth-looking, horrible to use.
 */
let inputDelays: number[] = [];
let inputDurations: number[] = [];

export function installEventTimingObserver(): void {
  if (!PROBE || typeof PerformanceObserver === 'undefined') return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const pe = e as PerformanceEventTiming;
        if (typeof pe.processingStart === 'number') {
          inputDelays.push(pe.processingStart - pe.startTime);
          inputDurations.push(pe.duration);
        }
      }
    });
    // durationThreshold 16 catches anything that missed a frame, rather than
    // the 104ms default which only surfaces catastrophes.
    obs.observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  } catch {
    /* Safari support is partial; the report says so rather than inventing zeros. */
  }
}

export function inputLatency() {
  const pick = (a: number[], q: number) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
  };
  return {
    supported: typeof PerformanceObserver !== 'undefined',
    samples: inputDelays.length,
    delayMedian: pick(inputDelays, 0.5),
    delayP95: pick(inputDelays, 0.95),
    delayMax: inputDelays.length ? Math.max(...inputDelays) : 0,
    durationP95: pick(inputDurations, 0.95),
    durationMax: inputDurations.length ? Math.max(...inputDurations) : 0,
  };
}

export function resetInputLatency(): void {
  inputDelays = [];
  inputDurations = [];
}

/**
 * Drag sweep — rotates the Universe through OrbitControls.
 *
 * The plain pointer sweep never presses a button, so it exercises hover and
 * raycasting but not the camera. Dragging is how a person actually explores the
 * field, and it drives OrbitControls damping, the CameraRig and a moving camera
 * through every frame, so it is the interaction most likely to be the one that
 * feels bad.
 */
export function runDragSweep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return resolve();
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: cx, clientY: cy }));
    const t0 = performance.now();
    const step = () => {
      const t = performance.now() - t0;
      if (t >= durationMs) {
        canvas.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: cx, clientY: cy, buttons: 0 }));
        return resolve();
      }
      const u = t / 1000;
      const x = cx + rect.width * 0.3 * Math.sin(u * 1.1);
      const y = cy + rect.height * 0.16 * Math.sin(u * 0.7);
      window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x, clientY: y }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x, clientY: y }));
      notePointerEvent();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/* ------------------------------------- round 5: presentation & capability --- */

/**
 * Round 5 exists because the owner runs **Safari on an M1 Air**, both dev and
 * production feel equally bad, and the production build measures healthy:
 * 901 drag frames, p99 23 ms, zero frames over 33 ms. Every previous round
 * measured JavaScript. None of them could see what happens after
 * `requestAnimationFrame` returns.
 *
 * What is between a rendered frame and a visible pixel:
 *   input → OrbitControls → camera matrix → useFrame → renderer.render()
 *   → [ GL command submission → GPU execution → WebKit compositing,
 *       including any backdrop-filter that samples the canvas → presentation ]
 *
 * Everything inside the brackets is invisible to `performance.now()`. rAF keeps
 * firing on the vsync cadence whether or not the pixels it produced ever
 * reached the screen on time — which is exactly how a page measures 60 fps and
 * feels bad.
 *
 * These probes get as close to the bracket as the platform allows, and report
 * honestly which ones the current browser actually supports.
 */

export interface Capabilities {
  buildMode: string;
  longtask: boolean;
  eventTiming: boolean;
  /** Chrome-only; WebKit does not expose it. Without it, no true GPU timing. */
  timerQuery: boolean;
  /** WebGL2 core — available in Safari 15+, and our best GPU-completion signal. */
  fenceSync: boolean;
  webglRenderer: string;
  webglVersion: string;
}

let caps: Capabilities | null = null;

export function readCapabilities(gl?: THREE.WebGLRenderer): Capabilities {
  if (caps) return caps;
  let timerQuery = false;
  let fenceSync = false;
  let webglRenderer = 'unknown';
  let webglVersion = 'unknown';
  try {
    const ctx = gl?.getContext() as WebGL2RenderingContext | undefined;
    if (ctx) {
      timerQuery = !!ctx.getExtension('EXT_disjoint_timer_query_webgl2');
      fenceSync = typeof ctx.fenceSync === 'function';
      webglVersion = String(ctx.getParameter(ctx.VERSION));
      const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
      if (dbg) webglRenderer = String(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      else webglRenderer = 'masked (WEBGL_debug_renderer_info withheld)';
    }
  } catch { /* context lost or unavailable */ }

  let eventTiming = false;
  try {
    // Presence in supportedEntryTypes is the only non-throwing way to ask.
    const types = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] })
      .supportedEntryTypes;
    eventTiming = Array.isArray(types) && types.includes('event');
  } catch { /* older engines */ }

  caps = {
    buildMode: import.meta.env.DEV ? 'development' : 'production',
    longtask: longTaskSupported,
    eventTiming,
    timerQuery,
    fenceSync,
    webglRenderer,
    webglVersion,
  };
  return caps;
}

/** Presentation-adjacent samples. All optional; unsupported ones stay empty. */
const rafLateness: number[] = [];
const gpuFence: number[] = [];
const inputToSubmit: number[] = [];

/**
 * How late the frame callback ran relative to the frame's own timestamp.
 *
 * `requestAnimationFrame(t)` receives the time the frame was *scheduled*. If
 * `performance.now()` on entry is far past `t`, the main thread started the
 * frame late — the one piece of pre-presentation delay JS can see directly, and
 * it works in every browser including Safari.
 */
export function noteRafLateness(scheduled: number): void {
  if (!PROBE) return;
  const late = performance.now() - scheduled;
  if (Number.isFinite(late)) rafLateness.push(late);
}

export function noteGpuFence(ms: number): void {
  gpuFence.push(ms);
}

export function noteInputToSubmit(ms: number): void {
  if (PROBE && Number.isFinite(ms) && ms >= 0) inputToSubmit.push(ms);
}

const pct = (a: number[], q: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

export function presentation() {
  return {
    rafLateness: { n: rafLateness.length, median: pct(rafLateness, 0.5), p95: pct(rafLateness, 0.95), max: rafLateness.length ? Math.max(...rafLateness) : 0 },
    gpuFence: { n: gpuFence.length, median: pct(gpuFence, 0.5), p95: pct(gpuFence, 0.95), max: gpuFence.length ? Math.max(...gpuFence) : 0 },
    inputToSubmit: { n: inputToSubmit.length, median: pct(inputToSubmit, 0.5), p95: pct(inputToSubmit, 0.95), max: inputToSubmit.length ? Math.max(...inputToSubmit) : 0 },
  };
}

export function resetPresentation(): void {
  rafLateness.length = 0;
  gpuFence.length = 0;
  inputToSubmit.length = 0;
}

/**
 * `?backdrop=off` — the decisive test for CSS compositing over the canvas.
 *
 * Four elements sit on top of the live WebGL surface with `backdrop-filter:
 * blur()`: the command row and its output panel (14px) and the two Universe
 * overlays (6px). A backdrop filter makes the compositor sample what is behind
 * the element, blur it, and composite — every frame, with the canvas as the
 * source. That work happens after rAF returns, so it is invisible to every
 * instrument in this file, and WebKit's path for it is materially worse than
 * Chrome's.
 *
 * This toggle only sets a class; the rule lives in App.css. Default is ON —
 * shipping visuals are untouched unless the flag is present.
 */
export function applyBackdropFlag(): void {
  if (typeof document === 'undefined') return;
  const q = new URLSearchParams(window.location.search);
  const noBackdrop = q.get('backdrop') === 'off';
  const noOverlay = q.get('overlay') === 'off';
  if (!noBackdrop && !noOverlay) return;

  // Injected at runtime rather than written into App.css, because the CSS
  // minifier rewrites `backdrop-filter` declarations: an authored
  // prefixed+unprefixed pair came out of the build as `-webkit-` only, which
  // would have disabled this toggle in Chrome and silently invalidated the
  // whole cross-browser comparison. An injected stylesheet is never minified.
  // The shipping stylesheets are untouched.
  const rules: string[] = [];
  if (noBackdrop) {
    document.documentElement.classList.add('diag-no-backdrop');
    rules.push(
      '.command-row,.command-out,.uv-clusters,.uv-skills{' +
        'backdrop-filter:none !important;-webkit-backdrop-filter:none !important}',
    );
  }
  if (noOverlay) {
    document.documentElement.classList.add('diag-no-overlay');
    rules.push('.uv-overlay,.command,.center-readout,.canvas-hint{display:none !important}');
  }
  const style = document.createElement('style');
  style.setAttribute('data-diag', 'true');
  style.textContent = rules.join('\n');
  document.head.appendChild(style);
}
