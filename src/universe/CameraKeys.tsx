/**
 * Keyboard camera control.
 *
 * OrbitControls binds arrow keys to panning, and panning is disabled here, so
 * without this the Universe cannot be moved at all without a mouse. The list
 * view is the accessible equivalent of the field's *content*; this is for the
 * sighted keyboard user who wants to look at the thing.
 *
 * Held keys are integrated against frame delta rather than handled per keydown
 * event, so movement is smooth and does not inherit the OS key-repeat delay.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { APOAPSIS } from '../domain/gravity';

const ORBIT_SPEED = 1.5; // radians/sec
const ZOOM_SPEED = 0.9; // fraction of range/sec
const MIN_R = APOAPSIS * 0.35;
const MAX_R = APOAPSIS * 2.6;
const MIN_POLAR = 0.12;
const MAX_POLAR = Math.PI * 0.88;

const KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  '+', '=', '-', '_',
]);

export function CameraKeys({ enabled = true }: { enabled?: boolean }) {
  const camera = useThree((s) => s.camera);
  // The drill-down (§15) can move the orbit pivot off the origin; keyboard
  // orbiting must revolve around the same pivot or the first arrow key while
  // drilled would snap the view back to the Core.
  const controls = useThree((s) => s.controls) as unknown as {
    target: THREE.Vector3;
  } | null;
  const held = useRef(new Set<string>());
  const spherical = useMemo(() => new THREE.Spherical(), []);
  const offset = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    if (!enabled) return;
    const down = (e: KeyboardEvent) => {
      // Never steal arrow keys from a text field or the lead listbox.
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el?.getAttribute('role') === 'listbox'
      ) {
        return;
      }
      if (!KEYS.has(e.key)) return;
      e.preventDefault();
      held.current.add(e.key);
    };
    const up = (e: KeyboardEvent) => held.current.delete(e.key);
    const blur = () => held.current.clear();

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    // Without this, a key held while the tab loses focus stays "down" forever.
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [enabled]);

  useFrame((_, delta) => {
    const keys = held.current;
    if (keys.size === 0) return;

    const pivot = controls?.target;
    offset.copy(camera.position);
    if (pivot) offset.sub(pivot);
    spherical.setFromVector3(offset);

    if (keys.has('ArrowLeft')) spherical.theta += ORBIT_SPEED * delta;
    if (keys.has('ArrowRight')) spherical.theta -= ORBIT_SPEED * delta;
    if (keys.has('ArrowUp')) spherical.phi -= ORBIT_SPEED * delta;
    if (keys.has('ArrowDown')) spherical.phi += ORBIT_SPEED * delta;

    const zoomIn = keys.has('+') || keys.has('=');
    const zoomOut = keys.has('-') || keys.has('_');
    if (zoomIn || zoomOut) {
      const step = (MAX_R - MIN_R) * ZOOM_SPEED * delta * (zoomIn ? -1 : 1);
      spherical.radius += step;
    }

    spherical.phi = Math.max(MIN_POLAR, Math.min(MAX_POLAR, spherical.phi));
    spherical.radius = Math.max(MIN_R, Math.min(MAX_R, spherical.radius));

    camera.position.setFromSpherical(spherical);
    if (pivot) {
      camera.position.add(pivot);
      camera.lookAt(pivot);
    } else {
      camera.lookAt(0, 0, 0);
    }
  });

  return null;
}
