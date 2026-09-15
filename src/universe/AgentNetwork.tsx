/**
 * The agent network.
 *
 * Seven agents sit on a ring above the disc. While an agent holds an in-flight
 * task, an arc runs from that agent down to the lead it is working, and the
 * agent's node brightens with its load.
 *
 * Every arc corresponds to a real `AgentTask` in the store. When the task
 * resolves the arc disappears and a `LeadEvent` lands, which is what actually
 * moves the lead. Nothing here is decorative motion.
 */

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { APOAPSIS } from '../domain/gravity';
import { readIndexOf, readTasks, useApsis } from '../state/store';
import { readField } from './fieldHandle';
import { useReducedMotion } from '../ui/useReducedMotion';

/**
 * Node ring placement.
 *
 * Wide enough to sit over the mid-field rather than crowding the Core, and low
 * enough that arcs bow *over* the disc instead of leaving the top of the frame.
 * An earlier, higher ring put the nodes level with the header and sent every arc
 * off-screen, which made the network unreadable at the default camera.
 */
const RING_RADIUS = APOAPSIS * 0.66;
const RING_HEIGHT = APOAPSIS * 0.30;
/** Node radius. Leads are ~2-4px; a node much above this outweighs the field. */
const NODE_RADIUS = 0.062;

/** Hard cap on simultaneously drawn arcs. See the note at the draw loop. */
const MAX_ARCS = 64;
/** Vertices per arc. Enough for a smooth quadratic at this scale. */
const ARC_SEGMENTS = 18;

export function AgentNetwork() {
  const agents = useApsis((s) => s.agents);
  const reducedMotion = useReducedMotion();

  /** Fixed node positions, evenly spaced around the ring. */
  const nodes = useMemo(
    () =>
      agents.map((a, i) => {
        const t = (i / agents.length) * Math.PI * 2;
        return {
          agent: a,
          position: new THREE.Vector3(
            Math.cos(t) * RING_RADIUS,
            RING_HEIGHT,
            Math.sin(t) * RING_RADIUS,
          ),
          color: new THREE.Color(a.color),
        };
      }),
    [agents],
  );

  const nodeRefs = useRef<(THREE.Mesh | null)[]>([]);

  // One LineSegments for every arc, allocated once at the cap and re-pointed each
  // frame. Building geometry per task per frame would allocate continuously.
  const { arcGeometry, arcMaterial, arcPositions, arcColors } = useMemo(() => {
    const verts = MAX_ARCS * ARC_SEGMENTS * 2;
    const arcPositions = new Float32Array(verts * 3);
    const arcColors = new Float32Array(verts * 3);
    const arcGeometry = new THREE.BufferGeometry();
    arcGeometry.setAttribute('position', new THREE.BufferAttribute(arcPositions, 3));
    arcGeometry.setAttribute('color', new THREE.BufferAttribute(arcColors, 3));
    const arcMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return { arcGeometry, arcMaterial, arcPositions, arcColors };
  }, []);

  const arcsRef = useRef<THREE.LineSegments>(null);

  // Scratch vectors, reused every frame.
  const scratch = useMemo(
    () => ({
      lead: new THREE.Vector3(),
      ctrl: new THREE.Vector3(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      load: new Map<string, number>(),
    }),
    [],
  );

  useFrame((state) => {
    const field = readField();
    const tasks = readTasks();
    const indexOf = readIndexOf();
    const now = Date.now();

    scratch.load.clear();
    let vert = 0;
    let drawn = 0;

    if (field) {
      for (const task of tasks.values()) {
        scratch.load.set(task.agentId, (scratch.load.get(task.agentId) ?? 0) + 1);

        // Arcs are capped, but the LOAD tally above is not — the agent nodes and
        // the roster still reflect every task, so a cap on what is drawn never
        // becomes a silent undercount of what is happening.
        if (drawn >= MAX_ARCS) continue;

        const idx = indexOf.get(task.leadId);
        if (idx === undefined) continue;

        const node = nodes.find((n) => n.agent.id === task.agentId);
        if (!node) continue;

        // The field buffer is in the field's local space and the field spins.
        scratch.lead
          .set(field.positions[idx * 3], field.positions[idx * 3 + 1], field.positions[idx * 3 + 2])
          .applyQuaternion(field.quaternion);

        // Lift the control point above both ends so the arc bows over the disc
        // instead of cutting through the field it is describing.
        scratch.ctrl
          .addVectors(node.position, scratch.lead)
          .multiplyScalar(0.5)
          .setY(Math.max(node.position.y, scratch.lead.y) + APOAPSIS * 0.07);

        // Progress lights the arc from the agent end toward the lead as the work
        // completes, so a long call reads differently from a quick SMS.
        const span = Math.max(1, task.dueAt - task.startedAt);
        const progress = Math.min(1, (now - task.startedAt) / span);

        for (let s = 0; s < ARC_SEGMENTS; s++) {
          const t0 = s / ARC_SEGMENTS;
          const t1 = (s + 1) / ARC_SEGMENTS;
          quadratic(scratch.a, node.position, scratch.ctrl, scratch.lead, t0);
          quadratic(scratch.b, node.position, scratch.ctrl, scratch.lead, t1);

          for (const [v, t] of [
            [scratch.a, t0],
            [scratch.b, t1],
          ] as const) {
            arcPositions[vert * 3] = v.x;
            arcPositions[vert * 3 + 1] = v.y;
            arcPositions[vert * 3 + 2] = v.z;
            // Leading edge bright, trailing edge dim.
            const lit = t <= progress ? 1 : 0.16;
            arcColors[vert * 3] = node.color.r * lit;
            arcColors[vert * 3 + 1] = node.color.g * lit;
            arcColors[vert * 3 + 2] = node.color.b * lit;
            vert++;
          }
        }
        drawn++;
      }
    }

    // Zero the tail so retired arcs do not linger as stale geometry.
    arcPositions.fill(0, vert * 3);
    arcGeometry.setDrawRange(0, vert);
    arcGeometry.getAttribute('position').needsUpdate = true;
    arcGeometry.getAttribute('color').needsUpdate = true;

    // Node brightness follows that agent's live task count.
    const pulse = reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 3.1);
    nodes.forEach((n, i) => {
      const mesh = nodeRefs.current[i];
      if (!mesh) return;
      const load = scratch.load.get(n.agent.id) ?? 0;
      const busy = Math.min(1, load / 4);
      mesh.scale.setScalar(1 + busy * 0.75 + (load > 0 ? pulse * 0.2 : 0));
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.34 + busy * 0.62;
    });
  });

  return (
    <group>
      <lineSegments ref={arcsRef} geometry={arcGeometry} material={arcMaterial} />
      {nodes.map((n, i) => (
        <mesh
          key={n.agent.id}
          position={n.position}
          ref={(m) => {
            nodeRefs.current[i] = m;
          }}
        >
          <sphereGeometry args={[NODE_RADIUS, 16, 16]} />
          <meshBasicMaterial
            color={n.agent.color}
            transparent
            opacity={0.4}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Quadratic Bézier into an existing vector — no allocation. */
function quadratic(
  out: THREE.Vector3,
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  t: number,
) {
  const u = 1 - t;
  out.set(
    u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
    u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z,
  );
}
