/**
 * Active Skills in the Universe (§12, §23).
 *
 * When a skill activates it materializes on a small ring just outside the
 * Intelligence Core, with an energy beam connecting it to the Core — the §23
 * "Apsis → skill connection". The skill → lead leg of the circuit is the agent
 * arc that already exists, drawn from the very task that makes the skill
 * EXECUTING here, so the whole chain derives from one set of facts.
 *
 * Nothing here is a state machine: every frame this re-derives presence from
 * the live task map and the recent feed (the same derivation `skills.ts`
 * formalises), eases node scale/opacity toward it, and draws. A skill with no
 * current work has presence 0 and is not drawn — the §12 rule that idle skills
 * do not appear is enforced by construction.
 *
 * Zero allocation in the frame loop: tallies live in two Maps allocated once
 * and cleared per frame, beam colors in a fixed buffer.
 */

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { APOAPSIS } from '../domain/gravity';
import { readTasks, useApsis } from '../state/store';
import { useReducedMotion } from '../ui/useReducedMotion';
import { INTEL_WINDOW_MS, SETTLE_MS, SKILLS } from './skills';

/** Just outside the appointment ring (PERIAPSIS 0.85), well inside the agent
 *  ring (0.66·A): skills belong to Apsis, agents work the field. */
const RING_RADIUS = APOAPSIS * 0.19;
const RING_HEIGHT = APOAPSIS * 0.115;
const NODE_RADIUS = 0.052;
/** Beams start just above the Core's volume so they read as emanating from it. */
const BEAM_ROOT_Y = 0.32;

export function SkillRing() {
  const reducedMotion = useReducedMotion();

  const nodes = useMemo(
    () =>
      SKILLS.map((skill, i) => {
        const t = (i / SKILLS.length) * Math.PI * 2 + 0.45;
        return {
          skill,
          position: new THREE.Vector3(
            Math.cos(t) * RING_RADIUS,
            RING_HEIGHT,
            Math.sin(t) * RING_RADIUS,
          ),
          color: new THREE.Color(skill.color),
        };
      }),
    [],
  );

  const nodeRefs = useRef<(THREE.Mesh | null)[]>([]);
  /** Eased presence per skill, 0..1. Display smoothing only — the underlying
   *  truth is re-derived every frame, so this can never desync from the store. */
  const presence = useRef(new Float32Array(SKILLS.length));

  const { beamGeometry, beamMaterial, beamColors } = useMemo(() => {
    const verts = SKILLS.length * 2;
    const beamPositions = new Float32Array(verts * 3);
    const beamColors = new Float32Array(verts * 3);
    for (let i = 0; i < SKILLS.length; i++) {
      // Root at the Core, tip at the node. Positions are static; only color
      // (and draw range via presence-zero color) changes.
      beamPositions[i * 6 + 1] = BEAM_ROOT_Y;
      beamPositions[i * 6 + 3] = nodes[i].position.x;
      beamPositions[i * 6 + 4] = nodes[i].position.y;
      beamPositions[i * 6 + 5] = nodes[i].position.z;
    }
    const beamGeometry = new THREE.BufferGeometry();
    beamGeometry.setAttribute('position', new THREE.BufferAttribute(beamPositions, 3));
    beamGeometry.setAttribute('color', new THREE.BufferAttribute(beamColors, 3));
    const beamMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return { beamGeometry, beamMaterial, beamColors };
  }, [nodes]);

  // Reused per-frame tallies — cleared, never reallocated.
  const scratch = useMemo(
    () => ({
      inFlight: new Map<string, number>(),
      settledAt: new Map<string, number>(),
    }),
    [],
  );

  useFrame((state, delta) => {
    const tasks = readTasks();
    const feed = useApsis.getState().feed;
    const now = Date.now();

    scratch.inFlight.clear();
    for (const task of tasks.values()) {
      scratch.inFlight.set(task.agentId, (scratch.inFlight.get(task.agentId) ?? 0) + 1);
    }

    scratch.settledAt.clear();
    let intelCount = 0;
    let newestAt = 0;
    for (const e of feed) {
      const age = now - e.at;
      if (age > INTEL_WINDOW_MS) break; // newest-first
      intelCount++;
      if (e.at > newestAt) newestAt = e.at;
      if (e.agentId && age <= SETTLE_MS && !scratch.settledAt.has(e.agentId)) {
        scratch.settledAt.set(e.agentId, e.at);
      }
    }

    const ease = 1 - Math.exp(-(reducedMotion ? 24 : 5.5) * delta);
    const shimmer = reducedMotion
      ? 1
      : 0.75 + 0.25 * Math.sin(state.clock.elapsedTime * 5.2);

    for (let i = 0; i < SKILLS.length; i++) {
      const spec = SKILLS[i];
      // Derived presence: EXECUTING → 1, COMPLETE/ERROR → fading with age,
      // Lead Intelligence → scaled by recent scoring volume. Idle → 0.
      let target = 0;
      let load = 0;
      if (spec.agentId === null) {
        if (intelCount > 0) {
          target = Math.min(1, 0.35 + intelCount / 40);
          load = Math.min(1, intelCount / 40);
        }
      } else {
        const flying = scratch.inFlight.get(spec.agentId) ?? 0;
        if (flying > 0) {
          target = 1;
          load = Math.min(1, flying / 4);
        } else {
          const at = scratch.settledAt.get(spec.agentId);
          if (at !== undefined) target = Math.max(0, 1 - (now - at) / SETTLE_MS) * 0.6;
        }
      }

      const v = presence.current[i] + (target - presence.current[i]) * ease;
      presence.current[i] = v;

      const mesh = nodeRefs.current[i];
      if (mesh) {
        mesh.visible = v > 0.02;
        if (mesh.visible) {
          mesh.scale.setScalar(0.35 + v * (0.85 + load * 0.7));
          (mesh.material as THREE.MeshBasicMaterial).opacity = v * 0.95;
        }
      }

      // Beam: dim at the Core, bright at the skill, both scaled by presence.
      const c = nodes[i].color;
      const rootLit = v * 0.18;
      const tipLit = v * (0.55 + load * 0.45) * shimmer;
      beamColors[i * 6] = c.r * rootLit;
      beamColors[i * 6 + 1] = c.g * rootLit;
      beamColors[i * 6 + 2] = c.b * rootLit;
      beamColors[i * 6 + 3] = c.r * tipLit;
      beamColors[i * 6 + 4] = c.g * tipLit;
      beamColors[i * 6 + 5] = c.b * tipLit;
    }
    beamGeometry.getAttribute('color').needsUpdate = true;
  });

  return (
    <group>
      <lineSegments geometry={beamGeometry} material={beamMaterial} />
      {nodes.map((n, i) => (
        <mesh
          key={n.skill.id}
          position={n.position}
          visible={false}
          ref={(m) => {
            nodeRefs.current[i] = m;
          }}
        >
          <sphereGeometry args={[NODE_RADIUS, 14, 14]} />
          <meshBasicMaterial
            color={n.skill.color}
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}
