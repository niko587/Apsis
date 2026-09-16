/**
 * The Universe canvas.
 *
 * Owns the renderer configuration and nothing else — no domain logic lives here.
 */

import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import * as THREE from 'three';
import { LeadField } from './LeadField';
import { IntelligenceCore, StageRings } from './Core';
import { AgentNetwork } from './AgentNetwork';
import { CameraKeys } from './CameraKeys';
import { CameraRig } from './CameraRig';
import { SkillRing } from './SkillRing';
import { UniverseOverlay } from './UniverseOverlay';
import { SelectedLeadCard, SelectedLeadFocus } from './SelectedLeadFocus';
import { APOAPSIS } from '../domain/gravity';
import { DIAG, LEGACY_FX, installRenderProbe } from '../diag/diagnostics';

/**
 * `?fx=off` disables the post pipeline (§20: degrade gracefully on weaker
 * hardware). Read once at module load — it is a URL, it cannot change without a
 * navigation.
 */
const FX_ON =
  typeof window === 'undefined' ||
  new URLSearchParams(window.location.search).get('fx') !== 'off';

export function Universe() {
  return (
    <>
    <Canvas
      // Capped DPR: on a 3x display an uncapped ratio triples the fragment cost
      // of a full-bleed additive field for no perceptible gain (§20).
      // `?dpr=N` overrides it for diagnosis only — default is unchanged.
      dpr={DIAG.dpr ?? [1, 2]}
      camera={{ fov: 46, near: 0.1, far: 240, position: [0, APOAPSIS * 0.72, APOAPSIS * 1.32] }}
      // MSAA off: the composer owns the framebuffer, so canvas-level MSAA would
      // be paid and then thrown away. Bloom's blur covers most aliasing on the
      // additive content this scene is made of.
      gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
      onCreated={({ gl, scene, raycaster }) => {
        // Tone mapping happens INSIDE the composer (see the ToneMapping effect
        // below), on the half-float frame, after bloom. Additive accumulation
        // on the dense cold rim goes well over 1.0 there, and ACES rolls that
        // off smoothly instead of clipping to flat white — which is what lets
        // the lead sprites run brighter than the pre-composer tuning allowed.
        gl.toneMapping = FX_ON ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
        scene.fog = new THREE.FogExp2('#03030a', 0.021);

        // Points have no surface to hit, so picking is a distance test against
        // the ray and this threshold IS the hit radius, in world units. Too
        // tight and leads are unclickable; too loose and the dense cold rim
        // grabs every click meant for something behind it.
        //
        // Set here rather than through the `raycaster` prop because that prop
        // types `params` as a complete RaycasterParameters — passing just the
        // Points entry fails to compile.
        raycaster.params.Points.threshold = 0.13;

        // No-op unless a diagnostic parameter is present.
        installRenderProbe(gl);
      }}
    >
      <color attach="background" args={['#03030a']} />
      <ambientLight intensity={0.22} />
      <StageRings />
      {/* `?field=off` / `?core=off` remove one draw cost each, for diagnosis.
          Both default to on; nothing about the shipping scene changes. */}
      {DIAG.field && <LeadField />}
      <AgentNetwork />
      <SkillRing />
      {DIAG.core && <IntelligenceCore />}
      {/* §14: the reticle that resolves an individually-focused lead. One
          mesh, one draw call, raycast-invisible; sits before the composer so
          its additive arcs ride the same bloom the lead sprites do. */}
      <SelectedLeadFocus />
      <CameraKeys />
      <CameraRig />
      {/* Post pipeline. Selectivity is by luminance, which in this scene IS
          selectivity by meaning: the only things bright enough to cross the
          threshold are the lead sprites' cores, the Intelligence Core and the
          lit span of the agent arcs — the stage rings, dimmed non-matches and
          background sit under it. That keeps the §5 luminosity hierarchy
          (leads, agents, Core) without a second selective render pass. */}
      {FX_ON && (
      <EffectComposer multisampling={0}>
        <Bloom
          mipmapBlur
          levels={5}
          intensity={0.62}
          luminanceThreshold={0.5}
          luminanceSmoothing={0.22}
          radius={0.5}
          // Bloom renders at half resolution (quarter the fragments) and is
          // upsampled by the mip chain. Its output is a blur, so the detail
          // discarded here is detail the effect was about to destroy anyway —
          // the glow's radius, intensity and colour are unchanged, which is why
          // this is an implementation change rather than a visual one. The
          // scene itself still renders at full DPR 2; only the bloom pyramid is
          // smaller. `?legacyfx=1` restores full-resolution bloom for A/B.
          resolutionScale={LEGACY_FX ? 1 : 0.5}
        />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
      )}
      {/* makeDefault publishes the controls into R3F state so the CameraRig
          and CameraKeys can pivot around the live drill target. */}
      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.06}
        minDistance={APOAPSIS * 0.35}
        maxDistance={APOAPSIS * 2.6}
        maxPolarAngle={Math.PI * 0.88}
      />
    </Canvas>
    {/* Real DOM (breadcrumb, skills). Portalled OUT of this aria-hidden
        wrapper — see UniverseOverlay. */}
    <UniverseOverlay />
    {/* §14: the in-scene confirmation card. aria-hidden — the announcer and
        the rail already speak; this is spatial confirmation, not a dashboard. */}
    <SelectedLeadCard />
    </>
  );
}
