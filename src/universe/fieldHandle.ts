/**
 * A live handle onto the rendered lead field.
 *
 * The agent arcs need each worked lead's on-screen position — which is the
 * eased, in-transit position held in the field's vertex buffer, not the target
 * `positionFor` would return. Routing that through React state would mean a
 * setState per frame; through context, a re-render of the whole subtree.
 *
 * So the field publishes a plain mutable handle at mount and readers pull from
 * it inside their own frame callbacks. One writer, many readers, no reactivity.
 */

import type * as THREE from 'three';

export interface FieldHandle {
  /** Interleaved xyz, in the field's LOCAL space. */
  positions: Float32Array;
  /** The field's current rotation. Local positions must be pushed through it. */
  quaternion: THREE.Quaternion;
}

let handle: FieldHandle | null = null;

export const publishField = (h: FieldHandle | null) => {
  handle = h;
};

export const readField = (): FieldHandle | null => handle;
