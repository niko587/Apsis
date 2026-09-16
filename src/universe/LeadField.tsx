/**
 * The Lead Universe field.
 *
 * Every lead in the book is one point in a single `THREE.Points` draw call. At
 * ~4,900 leads an InstancedMesh of spheres would also work, but points let the
 * whole field live in one buffer and cost one draw, which is what keeps headroom
 * for the Core, the agent arcs and post-processing inside the 60 FPS budget (§20).
 *
 * The critical structural rule: this component owns NO state. Each frame it reads
 * the store, asks `positionFor` where each lead belongs, and eases the rendered
 * position toward that. A lead moves if and only if its score moved. There is no
 * tween driving anything (§27 rule 3), and the field cannot drift out of sync
 * with the numbers in the UI because it re-derives from the same source (rule 4).
 */

import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { APOAPSIS, positionFor, colorFor } from '../domain/gravity';
import { readIndexOf, readLeads, readMatched, readOrder, useApsis } from '../state/store';
import { publishField } from './fieldHandle';
import { useReducedMotion } from '../ui/useReducedMotion';
import { matchesPath, type PathStep } from './clusters';
import { readDrillPath } from '../state/drillStore';
import { PROBE, bump, noteInputToSubmit, notePointerEvent, span } from '../diag/diagnostics';
import { isIndividualFocus } from './SelectedLeadFocus';

/**
 * How fast a lead slides to its new orbit, in "fraction of remaining distance
 * per second". Frame-rate independent via the delta-based exponential below —
 * a fixed per-frame lerp would make leads travel faster on a 120Hz display.
 */
const TRAVEL_RATE = 1.9;

/**
 * Motion trails.
 *
 * Each lead keeps a "trailing point" that chases its rendered position at a
 * slower rate than the position chases its target. While a lead is travelling
 * the trailing point lags behind along the actual path, and the gap is drawn as
 * a tapered comet tail; at rest the two converge and the trail vanishes. The
 * trail is therefore a pure derivative of real score-driven movement — there is
 * no timer, no tween and no state of its own, so it cannot show motion that did
 * not happen (§27 rules 3/4).
 */
const TRAIL_RATE = 0.75;
/** Squared gap below which a trail is invisible noise and is not drawn. */
const TRAIL_MIN_SQ = 0.03 * 0.03;
/** Hard cap on simultaneously drawn trails — same reasoning as the arc cap. */
const MAX_TRAILS = 400;
/** Tapered samples per trail. */
const TRAIL_SEGMENTS = 6;

const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uViewportScale;
  varying vec3 vColor;

  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Perspective size attenuation. Kept deliberately small: at ~4,900 additive
    // sprites, a generous point size makes neighbouring leads' glows overlap
    // until the field solves to a single white mass and every stage ring
    // disappears. Individual leads have to stay individually resolvable.
    // Scaled by viewport height, NOT a fixed pixel size. gl_PointSize is in
    // pixels, so a constant makes each lead cover a far larger share of a short
    // canvas than a tall one — on a stacked mobile layout the same 4,892 points
    // overlap into a single saturated mass and every stage ring disappears.
    // Tying size to viewport keeps apparent density constant across layouts.
    gl_PointSize = aSize * uViewportScale * (110.0 / -mv.z);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    float glow = pow(core, 3.0);
    // Tuned TOGETHER with the post pipeline: the composer renders to a
    // half-float buffer, so additive accumulation on the dense cold rim goes
    // over 1.0 and the final ACES pass rolls it off instead of clipping to
    // flat white. The hot centre of each sprite is pushed past the bloom
    // threshold so leads bloom individually; the sprite's skirt stays under it
    // so overlap reads as density, not as one fused glow.
    gl_FragColor = vec4(vColor * (0.3 + glow * 2.2), pow(core, 1.6) * 0.58);
  }
`;

export function LeadField() {
  const pointsRef = useRef<THREE.Points>(null);
  const fieldRef = useRef<THREE.Group>(null);
  const markerRef = useRef<THREE.Mesh>(null);
  const count = useApsis((s) => s.order.length);
  const select = useApsis((s) => s.select);
  const selectedId = useApsis((s) => s.selectedLeadId);
  const hover = useApsis((s) => s.hover);
  const reducedMotion = useReducedMotion();
  const lastRevision = useRef(-1);
  const lastMatched = useRef<Set<string> | null>(null);
  const lastDrill = useRef<readonly PathStep[] | null>(null);

  // All buffers allocated once. `current` is what is on screen, `target` is where
  // the domain says each lead belongs; the gap between them is the travel.
  // `trail` chases `current` and the gap between THOSE two is the motion trail.
  const { geometry, material, current, target, colors, sizes, trail, trailGeometry, trailMaterial, trailPositions, trailColors } = useMemo(() => {
    const current = new Float32Array(count * 3);
    const target = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const trail = new Float32Array(count * 3);

    // Trail draw buffers, allocated once at the cap and re-pointed each frame,
    // exactly like the agent arcs.
    const trailVerts = MAX_TRAILS * TRAIL_SEGMENTS * 2;
    const trailPositions = new Float32Array(trailVerts * 3);
    const trailColors = new Float32Array(trailVerts * 3);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
    trailGeometry.setAttribute('color', new THREE.BufferAttribute(trailColors, 3));
    trailGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), APOAPSIS * 1.15);
    const trailMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(current, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    // Fixed bounding sphere rather than computeBoundingSphere().
    //
    // Raycasting culls against this before testing points, and the positions
    // buffer changes every frame that anything is travelling — recomputing the
    // sphere per frame would walk the whole book again just to re-derive a value
    // the gravity model already bounds. No lead can ever sit outside apoapsis,
    // so a constant sphere is both cheaper and exactly correct.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), APOAPSIS * 1.15);

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uViewportScale: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    return { geometry, material, current, target, colors, sizes, trail, trailGeometry, trailMaterial, trailPositions, trailColors };
  }, [count]);

  // Seed the field at its correct position so the first frame is not an implosion
  // from the origin.
  const seeded = useRef(false);
  if (!seeded.current && count > 0) {
    const leads = readLeads();
    const order = readOrder();
    const color = new THREE.Color();
    for (let i = 0; i < order.length; i++) {
      const lead = leads.get(order[i]);
      if (!lead) continue;
      const p = positionFor(lead);
      current[i * 3] = target[i * 3] = trail[i * 3] = p.x;
      current[i * 3 + 1] = target[i * 3 + 1] = trail[i * 3 + 1] = p.y;
      current[i * 3 + 2] = target[i * 3 + 2] = trail[i * 3 + 2] = p.z;
      color.set(colorFor(lead.stage));
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
      sizes[i] = 1.15 + (lead.score / 100) * 2.35;
    }
    seeded.current = true;
  }

  /**
   * Round 3: time `Points.raycast` itself.
   *
   * three.js tests the ray against EVERY point in the geometry — there is no
   * acceleration structure — so this is O(book) per call, and R3F invokes it
   * from its pointer handling. Wrapping the instance method (rather than the
   * prototype) keeps the measurement scoped to this object, and it is only
   * installed under a diagnostic flag.
   */
  useEffect(() => {
    if (!PROBE) return;
    const points = pointsRef.current;
    if (!points) return;
    const original = points.raycast.bind(points);
    points.raycast = (raycaster, intersects) => {
      const t0 = performance.now();
      original(raycaster, intersects);
      span('pointsRaycast', performance.now() - t0);
      bump('raycasts');
      bump('pointsScanned', count);
    };
    return () => {
      points.raycast = THREE.Points.prototype.raycast;
    };
  }, [count]);

  // Publish the live buffer so the agent arcs can terminate on each lead's
  // actual on-screen position rather than its target orbit.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    publishField({ positions: current, quaternion: field.quaternion });
    return () => publishField(null);
  }, [current]);

  // Reused across frames — allocating a Color or Vector3 inside useFrame is the
  // classic way to hand the GC a sawtooth.
  const scratch = useMemo(() => new THREE.Color(), []);
  const lastTrailVerts = useRef(0);

  useFrame((state, delta) => {
    const probeT0 = PROBE ? performance.now() : 0;
    const points = pointsRef.current;
    const field = fieldRef.current;
    if (!points || !field) return;

    const revision = useApsis.getState().revision;
    const leads = readLeads();
    const order = readOrder();

    // Targets and colours only change when a score changes, so recompute them on
    // revision bumps rather than every frame. At a realistic event rate this
    // skips the whole 4,892-lead walk on the vast majority of frames.
    const matched = readMatched();
    // An empty matched set means "no command is filtering", which must render as
    // normal — not as every lead dimmed to nothing.
    const filtering = matched.size > 0;
    // The cluster drill-down (§15) reuses this same recede-don't-remove
    // mechanism: one luminance treatment, whether the subset came from a
    // command or from drilling. Path arrays are immutable, so identity
    // comparison detects a drill change exactly like the matched set.
    const drillPath = readDrillPath();
    const drilled = drillPath.length > 0;

    if (
      revision !== lastRevision.current ||
      matched !== lastMatched.current ||
      drillPath !== lastDrill.current
    ) {
      lastRevision.current = revision;
      lastMatched.current = matched;
      lastDrill.current = drillPath;
      // Round 3: how often the full-book walk actually runs, and over how many
      // leads. One event changes one lead; this counts what it costs anyway.
      if (PROBE) {
        bump('revisionWalks');
        bump('leadsRecalculated', order.length);
      }
      const walkT0 = PROBE ? performance.now() : 0;
      for (let i = 0; i < order.length; i++) {
        const lead = leads.get(order[i]);
        if (!lead) continue;
        const p = positionFor(lead);
        target[i * 3] = p.x;
        target[i * 3 + 1] = p.y;
        target[i * 3 + 2] = p.z;
        scratch.set(colorFor(lead.stage));
        // Leads outside the highlighted subset recede rather than vanish: the
        // shape of the whole book stays legible as context. A lead must clear
        // BOTH the command filter and the drilled cluster to stay lit.
        const inMatch = !filtering || matched.has(lead.id);
        const inCluster = !drilled || matchesPath(lead, drillPath);
        const lit = inMatch && inCluster ? 1 : 0.13;
        colors[i * 3] = scratch.r * lit;
        colors[i * 3 + 1] = scratch.g * lit;
        colors[i * 3 + 2] = scratch.b * lit;
        const base = 1.15 + (lead.score / 100) * 2.35;
        sizes[i] =
          filtering && inMatch
            ? base * 1.8
            : drilled && inCluster
              ? base * 1.3
              : base;
      }
      geometry.getAttribute('aColor').needsUpdate = true;
      geometry.getAttribute('aSize').needsUpdate = true;
      if (PROBE) span('revisionWalk', performance.now() - walkT0);
    }

    // Frame-rate independent approach to the target. Under reduced motion the
    // travel is shortened rather than removed: a lead still has to be seen
    // relocating, or the field stops explaining why it changed. The trail
    // shortens by the same factor — it derives from that same travel, so like
    // the travel it is shortened, never removed.
    const k = 1 - Math.exp(-(reducedMotion ? TRAVEL_RATE * 4 : TRAVEL_RATE) * delta);
    const kt = 1 - Math.exp(-(reducedMotion ? TRAIL_RATE * 4 : TRAIL_RATE) * delta);
    let moved = false;
    let tVert = 0;
    let trailsDrawn = 0;
    for (let i = 0; i < count; i++) {
      const j = i * 3;
      const dx = target[j] - current[j];
      const dy = target[j + 1] - current[j + 1];
      const dz = target[j + 2] - current[j + 2];
      if (dx * dx + dy * dy + dz * dz > 1e-8) {
        current[j] += dx * k;
        current[j + 1] += dy * k;
        current[j + 2] += dz * k;
        moved = true;
      }

      // Trailing point chases the rendered position. At rest it has converged
      // and everything below is a cheap no-op.
      let gx = current[j] - trail[j];
      let gy = current[j + 1] - trail[j + 1];
      let gz = current[j + 2] - trail[j + 2];
      const gapSq = gx * gx + gy * gy + gz * gz;
      if (gapSq <= 1e-8) continue;
      trail[j] += gx * kt;
      trail[j + 1] += gy * kt;
      trail[j + 2] += gz * kt;

      if (gapSq > TRAIL_MIN_SQ && trailsDrawn < MAX_TRAILS) {
        gx = current[j] - trail[j];
        gy = current[j + 1] - trail[j + 1];
        gz = current[j + 2] - trail[j + 2];
        const cr = colors[j];
        const cg = colors[j + 1];
        const cb = colors[j + 2];
        for (let s = 0; s < TRAIL_SEGMENTS; s++) {
          const t0 = s / TRAIL_SEGMENTS;
          const t1 = (s + 1) / TRAIL_SEGMENTS;
          // Tapered: dark at the tail, bright at the head, so the comet points
          // the way the lead is actually going.
          const f0 = t0 * t0 * 1.15;
          const f1 = t1 * t1 * 1.15;
          trailPositions[tVert * 3] = trail[j] + gx * t0;
          trailPositions[tVert * 3 + 1] = trail[j + 1] + gy * t0;
          trailPositions[tVert * 3 + 2] = trail[j + 2] + gz * t0;
          trailColors[tVert * 3] = cr * f0;
          trailColors[tVert * 3 + 1] = cg * f0;
          trailColors[tVert * 3 + 2] = cb * f0;
          tVert++;
          trailPositions[tVert * 3] = trail[j] + gx * t1;
          trailPositions[tVert * 3 + 1] = trail[j + 1] + gy * t1;
          trailPositions[tVert * 3 + 2] = trail[j + 2] + gz * t1;
          trailColors[tVert * 3] = cr * f1;
          trailColors[tVert * 3 + 1] = cg * f1;
          trailColors[tVert * 3 + 2] = cb * f1;
          tVert++;
        }
        trailsDrawn++;
      }
    }
    if (moved) geometry.getAttribute('position').needsUpdate = true;

    // Upload trail geometry only on frames where a trail exists or one just
    // retired — an idle field skips the GPU upload entirely.
    if (tVert > 0 || lastTrailVerts.current > 0) {
      trailGeometry.setDrawRange(0, tVert);
      trailGeometry.getAttribute('position').needsUpdate = true;
      trailGeometry.getAttribute('color').needsUpdate = true;
    }
    lastTrailVerts.current = tVert;

    // Track viewport height so apparent lead density survives a resize.
    const vs = Math.max(0.42, Math.min(1.25, state.size.height / 1000));
    if (material.uniforms.uViewportScale.value !== vs) {
      material.uniforms.uViewportScale.value = vs;
    }

    // The whole field turns slowly. This is ambient camera-less motion, not lead
    // movement — every lead keeps its bearing relative to its neighbours, and it
    // carries no information, so reduced motion drops it entirely. Applied to
    // the group so points and trails share one local space.
    if (!reducedMotion) field.rotation.y += delta * 0.018;

    // Park the selection marker on the selected lead's LIVE position, read from
    // the same buffer the GPU draws. Using `positionFor` here instead would pin
    // the marker to the lead's target orbit and leave it detached from the dot
    // for the whole duration of a move.
    //
    // The buffer holds positions in the FIELD's local space, and the field spins.
    // The marker is a sibling of the field rather than a child — it has to
    // billboard to the camera, which it cannot do while inheriting that spin — so
    // its position must be pushed through the field's rotation by hand.
    const marker = markerRef.current;
    if (marker) {
      const idx = selectedId ? (readIndexOf().get(selectedId) ?? -1) : -1;
      // §14: at full drill depth the SelectedLeadFocus reticle owns the
      // emphasis — two rings on one lead reads as clutter, so this small
      // tier-1 marker stands down while tier-2 focus is active. Same
      // predicate as the reticle, so exactly one of them shows at a time.
      const tier2 = idx >= 0 && isIndividualFocus(leads.get(selectedId!), drillPath);
      marker.visible = idx >= 0 && !tier2;
      if (idx >= 0) {
        marker.position
          .set(current[idx * 3], current[idx * 3 + 1], current[idx * 3 + 2])
          .applyQuaternion(field.quaternion);
        marker.scale.setScalar(reducedMotion ? 1.1 : 1 + Math.sin(state.clock.elapsedTime * 4) * 0.16);
        marker.quaternion.copy(state.camera.quaternion);
      }
    }

    if (PROBE) {
      span('leadFieldFrame', performance.now() - probeT0);
      // The settled-field question: this loop is O(count) unconditionally, so
      // counting the frames where nothing actually moved says how much of it
      // was wasted.
      if (!moved) bump('framesWithNoMovement');
    }
  });

  const onMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      notePointerEvent();
      // Input -> handler latency. `event.timeStamp` shares performance.now()'s
      // timebase, so this is the age of the input by the time Apsis reacts to
      // it. It stops short of presentation, which JS cannot see.
      if (PROBE && e.nativeEvent) noteInputToSubmit(performance.now() - e.nativeEvent.timeStamp);
      e.stopPropagation();
      const i = e.index;
      if (i === undefined) return;
      hover(readOrder()[i] ?? null);
    },
    [hover],
  );

  const onClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      const i = e.index;
      if (i === undefined) return;
      select(readOrder()[i] ?? null);
    },
    [select],
  );

  return (
    <group>
      {/* The rotating field: points and their motion trails share this local
          space, and its quaternion is what `fieldHandle` publishes. */}
      <group ref={fieldRef}>
        <points
          ref={pointsRef}
          geometry={geometry}
          material={material}
          onPointerMove={onMove}
          onPointerOut={() => hover(null)}
          onClick={onClick}
          onPointerMissed={() => select(null)}
        />
        <lineSegments geometry={trailGeometry} material={trailMaterial} />
      </group>
      {/* Billboarded selection ring. Sibling of the field, positioned by hand — see
          the marker block in useFrame for why it cannot simply be a child. */}
      <mesh ref={markerRef} visible={false}>
        <ringGeometry args={[0.17, 0.215, 40]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.9}
          depthTest={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}
