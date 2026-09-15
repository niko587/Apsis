/**
 * The Apsis Intelligence Core, and the appointment ring around it.
 *
 * The Core sits at the origin — periapsis, the destination of the whole field.
 * It is not decoration: its intensity is the store's measured event rate, so
 * when the pipeline is busy the centre visibly works, and when nothing is
 * happening it goes quiet. Anything else would be a screensaver.
 *
 * Rendered as a raymarched volume rather than a surface. The fragment shader
 * marches through a sphere of FBM noise, extracting filament structure that
 * reads as energy circulating INSIDE the Core (§8: "organic irregular spherical
 * form … blue → violet → magenta → hot pink energy"). A fresnel rim at the
 * entry surface keeps the silhouette contained. Step count is deliberately
 * modest — the Core covers a small share of the frame, and it must stay cheap
 * enough to leave the 60 FPS budget intact under software rasterization (§20).
 */

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { APOAPSIS, PERIAPSIS, radiusFor } from '../domain/gravity';
import { STAGES, STAGE_ORDER } from '../domain/types';
import { useApsis } from '../state/store';
import { useReducedMotion } from '../ui/useReducedMotion';

/** Maximum radius the volume can breathe out to; the geometry is sized to it. */
const CORE_RADIUS = PERIAPSIS * 0.72;

/**
 * Lattice period of the value noise, in noise-space cells.
 *
 * The noise is periodic so that TIME can be periodic. The scroll phase wraps at
 * this period on the CPU, and because the noise field repeats at exactly the
 * same period, the wrap is seamless — the shader cannot tell frame N from frame
 * N+loop. A plain `mod(time)` on a non-periodic field would visibly pop every
 * wrap, and unbounded time (what shipped first) degrades float32 precision so
 * a dashboard left open overnight slowly turns blocky. The field spans ~16
 * cells spatially, so a period of 64 never shows a visible spatial repeat, and
 * one full scroll loop takes 64 / 0.14 ≈ 7.6 minutes — no one holds a mental
 * image of exact filament positions that long.
 */
const NOISE_PERIOD = 64;
/** Swirl rate (rad/s) and scroll rate (noise cells/s). Phases, not raw time. */
const SWIRL_RATE = 0.22;
const SCROLL_RATE = 0.14;
const TAU = Math.PI * 2;

const coreVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Volume march. The Core never moves and never rotates as a mesh — the motion
 * lives in the noise field's phase inputs, so the geometry's model matrix stays
 * identity-with-translation and world space doubles as object space.
 *
 * Three defences against the animation glitching this shader used to show:
 *
 * 1. The march start is DITHERED per pixel. Sixteen steps against fbm whose
 *    finest octave is ~4× smaller than the step length is well under Nyquist,
 *    and with every pixel starting at the same half-step offset that
 *    undersampling organised into coherent banding shells that shimmered and
 *    popped as the field moved. Interleaved gradient noise staggers the sample
 *    positions so the residual error is fine static grain, which additive
 *    accumulation and bloom absorb.
 *
 * 2. The noise field's spatial frequency is FIXED (uNoiseFreq), not derived
 *    from the breathing radius. Dividing by uRadius re-scaled the whole noise
 *    domain every breath, and pushing that zoom through the narrow filament
 *    window made the filaments flicker at the breathing rate — fastest, and
 *    most visibly, exactly when the pipeline was busy. The breath still moves
 *    the silhouette and density falloff through uRadius; it no longer moves
 *    the pattern.
 *
 * 3. Time arrives as two WRAPPED phases (uSwirl in [0,2π), uScroll in
 *    [0,PERIOD)), never as raw elapsed seconds, and the lattice is periodic so
 *    the scroll wrap is invisible. See NOISE_PERIOD above.
 */
const coreFragment = /* glsl */ `
  uniform float uSwirl;      // swirl phase, wrapped to [0, 2pi) on the CPU
  uniform float uScroll;     // scroll phase, wrapped to [0, PERIOD) on the CPU
  uniform float uNoiseFreq;  // fixed spatial frequency — breathing must not zoom the field
  uniform float uIntensity;
  uniform float uRadius;
  uniform vec3 uDeep;
  uniform vec3 uMid;
  uniform vec3 uHot;
  varying vec3 vWorld;

  const float PERIOD = ${NOISE_PERIOD.toFixed(1)};

  // Bounded-input hash (Hoskins hash13). Inputs are lattice coords already
  // wrapped to [0, PERIOD), so every intermediate stays small and
  // well-conditioned in float32 regardless of how long the page has been open.
  float hash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  // Value noise on a lattice that repeats every PERIOD cells. Each corner is
  // wrapped independently so interpolation across the seam is exact.
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    vec3 a = mod(i, PERIOD);
    vec3 b = mod(i + 1.0, PERIOD);
    return mix(
      mix(mix(hash(vec3(a.x, a.y, a.z)), hash(vec3(b.x, a.y, a.z)), f.x),
          mix(hash(vec3(a.x, b.y, a.z)), hash(vec3(b.x, b.y, a.z)), f.x), f.y),
      mix(mix(hash(vec3(a.x, a.y, b.z)), hash(vec3(b.x, a.y, b.z)), f.x),
          mix(hash(vec3(a.x, b.y, b.z)), hash(vec3(b.x, b.y, b.z)), f.x), f.y),
      f.z);
  }

  // Lacunarity is exactly 2.0 — an integer, so every octave shares the base
  // lattice's period and the whole fbm tiles. 2.13 (the original) does not
  // divide the period and would break the seamless scroll wrap.
  float fbm(vec3 p) {
    float a = 0.5;
    float s = 0.0;
    s += a * noise(p); p = p * 2.0 + vec3(1.7); a *= 0.5;
    s += a * noise(p); p = p * 2.0 + vec3(1.7); a *= 0.5;
    s += a * noise(p);
    return s;
  }

  const int STEPS = 16;

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - cameraPosition);

    // Ray / sphere intersection at the live (breathing) radius.
    float b = dot(ro, rd);
    float c = dot(ro, ro) - uRadius * uRadius;
    float h = b * b - c;
    if (h < 0.0) discard;
    h = sqrt(h);
    float t0 = max(0.0, -b - h);
    float t1 = -b + h;
    float span = t1 - t0;
    if (span <= 0.0) discard;

    // Fresnel rim at the entry surface: contains the silhouette so the volume
    // reads as a body of energy, not an unbounded fog.
    vec3 entry = ro + rd * t0;
    vec3 n = entry / uRadius;
    float fres = pow(1.0 - abs(dot(n, -rd)), 2.2);

    float stepLen = span / float(STEPS);
    // Interleaved gradient noise: a stable per-pixel stagger for the march
    // start. Static per pixel, so it neither crawls nor needs a frame counter.
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float t = t0 + stepLen * jitter;
    vec3 acc = vec3(0.0);

    // The field swirls: sample space rotates about Y with depth-dependent
    // twist, so filaments shear instead of rotating as a rigid ball.
    float ca = cos(uSwirl);
    float sa = sin(uSwirl);

    for (int i = 0; i < STEPS; i++) {
      vec3 p = ro + rd * t;
      float r = length(p) / uRadius;          // 0 centre .. 1 surface
      float twist = 1.0 - r * 0.6;
      vec3 q = vec3(ca * p.x - sa * twist * p.z, p.y, sa * twist * p.x + ca * p.z);

      float nz = fbm(q * uNoiseFreq + vec3(0.0, uScroll, 0.0));
      // Filament extraction: only a narrow crest of the noise emits, so the
      // volume is threaded with fine strands rather than continents of haze.
      float fil = smoothstep(0.5, 0.6, nz) * (1.0 - smoothstep(0.68, 0.8, nz));
      fil *= fil;

      float centre = 1.0 - r;
      // Base haze so the volume has body between filaments.
      float dens = fil * (1.4 + uIntensity * 2.1) + centre * centre * 1.1;
      // Fade toward the surface so the silhouette is a soft energy boundary,
      // not a hard-edged ball.
      dens *= smoothstep(1.0, 0.88, r);

      // Colour ramps deep violet-blue -> violet with density, threaded with
      // magenta along the filaments — brighter when the pipeline is busy.
      vec3 col = mix(uDeep, uMid, min(1.0, fil * 0.9 + centre * 0.6));
      col = mix(col, uHot, min(1.0, fil * (0.45 + uIntensity * 0.55)));
      acc += col * dens * stepLen;
    }

    acc *= (5.4 + uIntensity * 3.8) / uRadius;
    acc += uMid * fres * (1.05 + uIntensity * 1.2);

    gl_FragColor = vec4(acc, 1.0);
  }
`;

export function IntelligenceCore() {
  const mesh = useRef<THREE.Mesh>(null);
  const eventRate = useApsis((s) => s.telemetry.eventRate);
  const reducedMotion = useReducedMotion();

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: coreVertex,
        fragmentShader: coreFragment,
        uniforms: {
          uSwirl: { value: 0 },
          uScroll: { value: 0 },
          uNoiseFreq: { value: 7.0 / CORE_RADIUS },
          uIntensity: { value: 0 },
          uRadius: { value: CORE_RADIUS },
          uDeep: { value: new THREE.Color('#2b1a7e') },
          uMid: { value: new THREE.Color('#7d4dff') },
          uHot: { value: new THREE.Color('#ff4fc8') },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.FrontSide,
      }),
    [],
  );

  const smoothed = useRef(0);

  useFrame((state, delta) => {
    // Normalised against a busy-pipeline rate; smoothed so the Core breathes
    // rather than strobes on individual events.
    const load = Math.min(1, eventRate / 120);
    smoothed.current += (load - smoothed.current) * Math.min(1, delta * 2.4);

    const t = state.clock.elapsedTime;
    // Under reduced motion the Core holds a steady level that still encodes load
    // — the brightness is information, the breathing and internal swirl are not,
    // so the phase inputs freeze and the radius stops modulating.
    const breath = reducedMotion
      ? 0.5
      : 0.5 + 0.5 * Math.sin(t * (0.8 + smoothed.current * 2.6));
    material.uniforms.uIntensity.value = smoothed.current * 0.75 + breath * 0.25;
    if (!reducedMotion) {
      // Wrapped phases, not raw seconds. `t` is a float64 here, so the modulo
      // is exact for days of uptime; the shader only ever sees a small number.
      material.uniforms.uSwirl.value = (t * SWIRL_RATE) % TAU;
      material.uniforms.uScroll.value = (t * SCROLL_RATE) % NOISE_PERIOD;
    }
    material.uniforms.uRadius.value =
      CORE_RADIUS * (reducedMotion ? 1 : 0.94 + breath * 0.05 * (0.6 + smoothed.current));
  });

  return (
    <group>
      {/* Geometry slightly larger than the breathing radius ever gets: the
          march discards outside uRadius, so the mesh is only a fragment
          generator and never shows its own faceted surface. */}
      <mesh ref={mesh} material={material}>
        <icosahedronGeometry args={[CORE_RADIUS * 1.08, 3]} />
      </mesh>
      <pointLight color="#8f6bff" intensity={7} distance={APOAPSIS * 1.4} decay={2} />
    </group>
  );
}

/**
 * One faint ring per stage boundary.
 *
 * These are the annuli the gravity model actually produces — drawn from
 * `radiusFor` rather than hand-placed, so if the scoring bands are ever retuned
 * the guides move with them instead of quietly lying.
 */
export function StageRings() {
  const rings = useMemo(
    () =>
      STAGE_ORDER.map((id) => ({
        id,
        radius: radiusFor(STAGES[id].lo),
        color: STAGES[id].color,
      })),
    [],
  );

  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      {rings.map((r) => (
        <mesh key={r.id}>
          <ringGeometry args={[r.radius - 0.012, r.radius + 0.012, 128]} />
          <meshBasicMaterial
            color={r.color}
            transparent
            opacity={0.14}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}
