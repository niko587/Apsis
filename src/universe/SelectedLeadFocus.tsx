/**
 * §14 — the spatial resolution of an individual lead.
 *
 * When the drill journey reaches its last step and a lead is selected, the
 * Universe should answer with more than a camera lean: the lead becomes the
 * subject of the frame. This file supplies both halves of that answer —
 *
 *   `SelectedLeadFocus`  lives INSIDE the canvas: a single billboarded quad
 *                        whose fragment shader draws a fine two-ring reticle
 *                        with three slowly-orbiting arc segments and a soft
 *                        halo, in the lead's own stage colour. One mesh, one
 *                        draw call, raycast-invisible.
 *
 *   `SelectedLeadCard`   lives OUTSIDE the canvas: a compact DOM card portalled
 *                        into `.stage`, tracking the lead in screen space,
 *                        carrying name / stage / score plus next action —
 *                        the same authoritative fields the rail shows in full.
 *
 * The visual idea is orbital resolution, in the product's own metaphor: the
 * system has brought one body into focus. Rings, not rays; measurement, not
 * fireworks. The reticle's centre stays clear so the lead's actual sprite —
 * the thing that has been travelling this whole journey — remains the bright
 * core of the composition.
 *
 * CONTRACT NOTES (docs/CONTRACT_14_SPATIAL_INDIVIDUAL.md):
 * - No new state. Focus is derived: selection + full drill depth + membership.
 * - The lead's position is read from the live field buffer and NEVER written.
 * - One extra draw call total (budget: two).
 * - The card is aria-hidden — SelectionAnnouncer and the rail already speak.
 * - No backdrop-filter anywhere near this file.
 * - Reduced motion freezes the orbits and the pulse; nothing disappears.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import type { Lead } from '../domain/types';
import { STAGES } from '../domain/types';
import { nextBestAction } from '../domain/nextAction';
import { readIndexOf, useApsis } from '../state/store';
import { readDrillPath, useDrill } from '../state/drillStore';
import { useThrottledRevision } from '../ui/useThrottledRevision';
import { useReducedMotion } from '../ui/useReducedMotion';
import { DRILL_SEQUENCE, matchesPath, type PathStep } from './clusters';
import { readField } from './fieldHandle';

const TAU = Math.PI * 2;

/**
 * The single question both halves (and LeadField's small marker) ask.
 *
 * Tier 2 of the contract's state model: a selection AT FULL DRILL DEPTH whose
 * lead is still inside the drilled cluster. A lead whose score carried it out
 * of the cluster mid-focus fails the membership test and focus dissolves —
 * the camera falls back to the cluster framing rather than chasing a dimmed
 * stranger outside it.
 */
export function isIndividualFocus(
  lead: Lead | null | undefined,
  path: readonly PathStep[],
): boolean {
  return !!lead && path.length >= DRILL_SEQUENCE.length && matchesPath(lead, path);
}

/**
 * Clamp the card's screen anchor inside the stage.
 *
 * Pure so it can be unit-tested: the card flips to the left of the lead when
 * the right edge would clip it, and is confined to the band above `reserveY`
 * (the top of the command bar) so it can never sit on the primary interface.
 */
export function clampCard(
  x: number,
  y: number,
  stageW: number,
  stageH: number,
  cardW: number,
  cardH: number,
  reserveY: number,
): { x: number; y: number; flipped: boolean } {
  const pad = 12;
  // Clearance is measured from the LEAD's screen point, so it must clear the
  // reticle's on-screen radius (~90px at the committed camera distance) plus
  // breathing room — the card frames the resolution, it never sits on it.
  const gap = 64;
  let flipped = false;
  let cx = x + gap;
  if (cx + cardW + pad > stageW) {
    cx = x - gap - cardW;
    flipped = true;
  }
  cx = Math.min(Math.max(pad, cx), Math.max(pad, stageW - cardW - pad));
  const maxY = Math.min(stageH, reserveY) - cardH - pad;
  const cy = Math.min(Math.max(pad, y - cardH * 0.5), Math.max(pad, maxY));
  return { x: cx, y: cy, flipped };
}

/* ------------------------------------------------------------ shared handle --- */

/**
 * The canvas half writes the card's screen position straight onto the DOM node
 * each frame — no React render, no state, same publish pattern as fieldHandle.
 */
const cardHandle: { el: HTMLDivElement | null } = { el: null };

/* ---------------------------------------------------------------- reticle --- */

const reticleVertex = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xy * 2.0; // unit quad → [-1,1]
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Two thin rings, three orbiting arc segments, a soft interior halo.
 *
 * All intensity, no texture: the additive result rides the same half-float →
 * bloom → ACES pipeline as the lead sprites, so the reticle's hot arcs bloom
 * exactly the way the leads themselves do and the whole construction reads as
 * native to the field rather than pasted over it.
 *
 * `uPhase` is a wrapped phase in [0, 2π), never raw elapsed seconds (D15).
 */
const reticleFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPhase;
  uniform float uPulse;   // 0..1 breathing, frozen at 1.0 under reduced motion
  uniform float uFade;    // enter/exit opacity
  varying vec2 vP;

  void main() {
    float r = length(vP);
    if (r > 1.0) discard;
    float ang = atan(vP.y, vP.x);

    // Outer ring: the boundary of the resolved body. Fine, steady.
    float outer = smoothstep(0.030, 0.004, abs(r - 0.84));

    // Three arc segments patrolling the outer ring — the "measurement" motion.
    float sweep = 0.5 + 0.5 * sin(ang * 3.0 - uPhase);
    float arcs = smoothstep(0.075, 0.012, abs(r - 0.84)) * smoothstep(0.80, 0.97, sweep);

    // Inner ring: quieter, holds the centre without crowding the sprite.
    float inner = smoothstep(0.020, 0.003, abs(r - 0.42)) * 0.55;

    // Halo: a breath of the stage colour pooled around the lead.
    float halo = exp(-r * 3.4) * (0.16 + 0.10 * uPulse);

    float m = outer * (0.5 + 0.3 * uPulse) + arcs * 1.15 + inner + halo;
    // Premultiplied-feeling additive: colour and alpha carry the same energy.
    gl_FragColor = vec4(uColor * m, m * 0.85) * uFade;
  }
`;

/** World diameter of the reticle. Sized to ring a lead sprite, not swallow it. */
const RETICLE_SCALE = 0.72;
/** Orbit rate of the arc segments (rad/s) and breath rate (Hz-ish). */
const ORBIT_RATE = 0.9;
const BREATH_RATE = 1.7;
/** Fade responsiveness — exponential, frame-rate independent. */
const FADE_RATE = 7;

export function SelectedLeadFocus() {
  const meshRef = useRef<THREE.Mesh>(null);
  const reducedMotion = useReducedMotion();

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: reticleVertex,
        fragmentShader: reticleFragment,
        uniforms: {
          uColor: { value: new THREE.Color('#ffffff') },
          uPhase: { value: 0 },
          uPulse: { value: 1 },
          uFade: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        // Always visible through the field, like the existing marker: an
        // occluded reticle reads as a bug, not as depth.
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  // Scratch — allocated once. The frame loop below allocates nothing.
  const s = useMemo(
    () => ({
      world: new THREE.Vector3(),
      ndc: new THREE.Vector3(),
      color: new THREE.Color(),
      lastStage: '' as string,
      fade: 0,
      // Throttled DOM measurements (see the card): refreshed every ~20 frames.
      frame: 0,
      cardW: 280,
      cardH: 96,
      reserveY: Number.POSITIVE_INFINITY,
    }),
    [],
  );

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const app = useApsis.getState();
    const path = readDrillPath();
    const field = readField();
    const lead = app.selectedLeadId ? app.leads.get(app.selectedLeadId) : null;
    const idx =
      lead && field ? (readIndexOf().get(lead.id) ?? -1) : -1;

    const active = idx >= 0 && !!field && isIndividualFocus(lead, path);

    // Exponential fade both directions; the mesh only exists on screen while
    // there is something to show.
    const k = 1 - Math.exp(-FADE_RATE * delta);
    s.fade += ((active ? 1 : 0) - s.fade) * (reducedMotion ? 1 : k);
    mesh.visible = s.fade > 0.01;
    material.uniforms.uFade.value = s.fade;

    const card = cardHandle.el;
    if (!mesh.visible || !active || !lead || !field) {
      if (card) card.style.opacity = '0';
      return;
    }

    // Live rendered position (field-local), pushed through the field's spin —
    // the same recipe as the marker block, and the reason the reticle stays
    // welded to the sprite while the whole disc rotates.
    s.world
      .set(field.positions[idx * 3], field.positions[idx * 3 + 1], field.positions[idx * 3 + 2])
      .applyQuaternion(field.quaternion);
    mesh.position.copy(s.world);
    mesh.quaternion.copy(state.camera.quaternion);

    const breath = reducedMotion ? 1 : 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * BREATH_RATE);
    mesh.scale.setScalar(RETICLE_SCALE * (reducedMotion ? 1 : 0.97 + 0.05 * breath));
    material.uniforms.uPulse.value = breath;
    if (!reducedMotion) {
      material.uniforms.uPhase.value = (state.clock.elapsedTime * ORBIT_RATE) % TAU;
    }

    // Stage colour — re-parsed only when the stage actually changes.
    if (lead.stage !== s.lastStage) {
      s.lastStage = lead.stage;
      s.color.set(STAGES[lead.stage].color);
      (material.uniforms.uColor.value as THREE.Color).copy(s.color);
    }

    // ---- card tracking (one DOM write per frame; measurements throttled) ----
    if (card) {
      if (s.frame++ % 20 === 0) {
        s.cardW = card.offsetWidth || s.cardW;
        s.cardH = card.offsetHeight || s.cardH;
        const command = document.querySelector('.command');
        const stage = card.parentElement;
        if (command && stage) {
          s.reserveY =
            command.getBoundingClientRect().top - stage.getBoundingClientRect().top;
        }
      }
      s.ndc.copy(s.world).project(state.camera);
      if (s.ndc.z > 1) {
        card.style.opacity = '0'; // behind the camera — vanish rather than mirror
      } else {
        const px = (s.ndc.x * 0.5 + 0.5) * state.size.width;
        const py = (1 - (s.ndc.y * 0.5 + 0.5)) * state.size.height;
        const c = clampCard(px, py, state.size.width, state.size.height, s.cardW, s.cardH, s.reserveY);
        card.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0)`;
        card.style.opacity = s.fade.toFixed(3);
      }
    }
  });

  return (
    <mesh ref={meshRef} material={material} visible={false} raycast={() => null}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

/* ------------------------------------------------------------------- card --- */

/**
 * The in-scene confirmation. Compact, aria-hidden, pointer-transparent.
 *
 * Content renders through React only when the selection or the throttled
 * revision changes; position is written imperatively by the canvas half. The
 * card never scrolls — if it wanted to, it would be carrying too much.
 */
export function SelectedLeadCard() {
  const selectedId = useApsis((s) => s.selectedLeadId);
  const leads = useApsis((s) => s.leads);
  const claimed = useApsis((s) => s.claimed);
  const path = useDrill((s) => s.path);
  const revision = useThrottledRevision();

  const lead = selectedId ? leads.get(selectedId) : null;
  // `revision` keeps score/stage fresh as events land on the focused lead.
  void revision;

  const stageHost = document.querySelector('.stage');
  if (!stageHost || !isIndividualFocus(lead, path)) return null;
  const spec = STAGES[lead!.stage];
  const action = nextBestAction(lead!, Date.now(), claimed.has(lead!.id));

  return createPortal(
    <div
      className="uv-lead-card"
      aria-hidden="true"
      ref={(el) => {
        cardHandle.el = el;
      }}
    >
      <div className="uv-lead-card-name">{lead!.name}</div>
      <div className="uv-lead-card-row">
        <span className="uv-lead-card-stage">
          <span className="uv-lead-card-dot" style={{ background: spec.color }} />
          {spec.label}
        </span>
        <span className="uv-lead-card-score" style={{ color: spec.color }}>
          {Math.round(lead!.score)}
        </span>
      </div>
      <div className="uv-lead-card-meta">
        {lead!.segment} · {lead!.location}
      </div>
      <div className="uv-lead-card-action">{action.label}</div>
    </div>,
    stageHost,
  );
}
