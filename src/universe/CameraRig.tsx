/**
 * Camera choreography for the cluster drill-down (§15).
 *
 * Drilling in is a framing MOVE, not a cut: each frame the camera eases toward
 * a framing derived from the drilled cluster's actual member distribution —
 * their centroid and spread, computed from the same `positionFor` the field
 * draws with. Geography and segment clusters are scattered over the whole disc
 * by design (score is the only thing that moves a lead, so drilling cannot
 * herd them), which is why each level ALSO tightens distance and steepens the
 * polar angle: the descent reads as a move even when the spread does not
 * shrink, and a genuinely compact cluster (e.g. temperature=booked) gets a
 * genuinely tight framing from the same formula.
 *
 * The ease is a frame-rate-independent exponential approach inside useFrame —
 * no tween object, no timeline, nothing owns the camera between frames. Under
 * `prefers-reduced-motion` the approach rate is cranked so the move completes
 * near-instantly; it is never removed, because the destination carries the
 * information.
 *
 * While drilled the rig keeps only the TARGET tracking the cluster (the field
 * rotates slowly under it); once the position transition settles the camera
 * itself is handed back to the user, so orbiting and zooming inside a cluster
 * work exactly as they do at GLOBAL.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { APOAPSIS, positionFor } from '../domain/gravity';
import { readIndexOf, readLeads, useApsis } from '../state/store';
import { useReducedMotion } from '../ui/useReducedMotion';
import { DRILL_SEQUENCE, matchesPath, type PathStep } from './clusters';
import { readDrillPath } from '../state/drillStore';
import { readField } from './fieldHandle';

/** Where the default camera sits, in spherical terms: matches the Canvas
 *  `camera` prop of [0, 0.72·A, 1.32·A]. */
const HOME_RADIUS = APOAPSIS * Math.hypot(0.72, 1.32);
const HOME_PHI = Math.acos(0.72 / Math.hypot(0.72, 1.32));

/** Distance limits must respect the OrbitControls min/max distance, or the
 *  controls' own clamp snaps the camera the frame after we place it. */
const MIN_DIST = APOAPSIS * 0.36;
const MAX_DIST = APOAPSIS * 1.4;

/**
 * §14 — how close the camera commits when a single lead is the destination.
 *
 * Chosen just above MIN_DIST (and therefore above OrbitControls.minDistance,
 * which stays untouched): close enough that one sprite plus its reticle owns
 * the frame, far enough that the cluster's other members stay in view behind
 * it — the point of §15's recede-don't-remove survives the arrival.
 */
const INDIVIDUAL_DIST = APOAPSIS * 0.44;
/** The gaze lifts slightly at the individual level: meeting the lead, not
 *  inspecting it from above. Applied on top of the depth-derived phi. */
const INDIVIDUAL_PHI_LIFT = 0.16;

interface ControlsLike {
  target: THREE.Vector3;
  update: () => void;
}

interface Focus {
  centroid: THREE.Vector3;
  radius: number;
  depth: number;
}

/** Centroid + spread of the drilled member set, in field-LOCAL space.
 *  Runs once per drill change, never per frame. */
function computeFocus(path: readonly PathStep[], focus: Focus) {
  focus.depth = path.length;
  if (path.length === 0) {
    focus.centroid.set(0, 0, 0);
    focus.radius = APOAPSIS;
    return;
  }
  const leads = readLeads();
  let n = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const lead of leads.values()) {
    if (!matchesPath(lead, path)) continue;
    const p = positionFor(lead);
    cx += p.x;
    cy += p.y;
    cz += p.z;
    n++;
  }
  if (n === 0) {
    focus.centroid.set(0, 0, 0);
    focus.radius = APOAPSIS;
    return;
  }
  focus.centroid.set(cx / n, cy / n, cz / n);
  let r2 = 0;
  for (const lead of leads.values()) {
    if (!matchesPath(lead, path)) continue;
    const p = positionFor(lead);
    const dx = p.x - focus.centroid.x;
    const dy = p.y - focus.centroid.y;
    const dz = p.z - focus.centroid.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  focus.radius = Math.max(1, Math.sqrt(r2));
}

export function CameraRig() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as ControlsLike | null;
  const reducedMotion = useReducedMotion();

  const lastPath = useRef<readonly PathStep[] | null>(null);
  /** True while the camera position is still travelling to a new framing. */
  const settling = useRef(false);
  /**
   * §14: the lead currently owning individual focus, or null. Tracked so that
   * entering, leaving AND retargeting focus all re-arm `settling` — the move
   * must animate in every direction, never cut (contract §C.7).
   */
  const lastFocusId = useRef<string | null>(null);

  const focus = useMemo<Focus>(
    () => ({ centroid: new THREE.Vector3(), radius: APOAPSIS, depth: 0 }),
    [],
  );
  // Scratch — allocated once, reused every frame.
  const s = useMemo(
    () => ({
      desiredT: new THREE.Vector3(),
      desiredP: new THREE.Vector3(),
      offset: new THREE.Vector3(),
      sph: new THREE.Spherical(),
      lead: new THREE.Vector3(),
    }),
    [],
  );

  useFrame((_, delta) => {
    if (!controls) return;
    const path = readDrillPath();
    if (path !== lastPath.current) {
      lastPath.current = path;
      computeFocus(path, focus);
      settling.current = true;
    }
    const field = readField();

    // §14 — individual focus: a selection at full drill depth whose lead is
    // still inside the drilled cluster. A lead whose score carried it out of
    // the cluster mid-focus fails the membership test, and the rig falls back
    // to the cluster framing instead of chasing a dimmed stranger (contract §K).
    const appState = useApsis.getState();
    let focusIdx = -1;
    let focusId: string | null = null;
    if (appState.selectedLeadId && focus.depth >= DRILL_SEQUENCE.length && field) {
      const lead = appState.leads.get(appState.selectedLeadId);
      if (lead && matchesPath(lead, path)) {
        const idx = readIndexOf().get(lead.id);
        if (idx !== undefined) {
          focusId = lead.id;
          focusIdx = idx;
        }
      }
    }
    // Entering, leaving or switching focus is a framing change: animate it.
    if (focusId !== lastFocusId.current) {
      lastFocusId.current = focusId;
      settling.current = true;
    }

    // Fully home and settled: the rig is inert and the user owns the camera.
    if (!settling.current && focus.depth === 0) return;

    // Target: the cluster centroid, pushed through the field's live rotation.
    s.desiredT.copy(focus.centroid);
    if (field) s.desiredT.applyQuaternion(field.quaternion);

    // At individual focus the target ARRIVES on the lead's live rendered
    // position — the journey's last step completes instead of leaning 45% and
    // stopping. The buffer is field-local and the field spins, hence the
    // quaternion (contract §C.1–3).
    if (focusIdx >= 0 && field) {
      s.lead
        .set(
          field.positions[focusIdx * 3],
          field.positions[focusIdx * 3 + 1],
          field.positions[focusIdx * 3 + 2],
        )
        .applyQuaternion(field.quaternion);
      s.desiredT.copy(s.lead);
    }

    // Position: preserve the user's azimuth; radius and polar come from the
    // framing. Deeper levels dolly in and look down more steeply.
    s.offset.copy(camera.position).sub(s.desiredT);
    s.sph.setFromVector3(s.offset);
    if (focus.depth === 0) {
      s.sph.radius = HOME_RADIUS;
      s.sph.phi = HOME_PHI;
    } else {
      const fit = Math.min(MAX_DIST, Math.max(MIN_DIST, focus.radius * 2.35));
      s.sph.radius = Math.max(MIN_DIST, fit * Math.pow(0.82, focus.depth - 1));
      s.sph.phi = Math.max(0.34, HOME_PHI - 0.17 * focus.depth);
      // §14: commit. The dolly tightens to the individual distance and the
      // gaze lifts a touch — arriving to meet the lead against the field,
      // rather than looking down onto it. Azimuth stays the user's.
      if (focusIdx >= 0) {
        s.sph.radius = INDIVIDUAL_DIST;
        s.sph.phi = Math.min(Math.PI * 0.72, s.sph.phi + INDIVIDUAL_PHI_LIFT);
      }
    }
    s.desiredP.setFromSpherical(s.sph).add(s.desiredT);

    // Frame-rate-independent approach; near-instant under reduced motion so
    // the framing (which is information) survives while the glide (which is
    // not) effectively disappears.
    const rate = reducedMotion ? 24 : 3.1;
    const k = 1 - Math.exp(-rate * delta);
    controls.target.lerp(s.desiredT, k);
    if (settling.current) {
      camera.position.lerp(s.desiredP, k);
      if (camera.position.distanceToSquared(s.desiredP) < 0.004) {
        settling.current = false;
      }
    }
  });

  return null;
}
