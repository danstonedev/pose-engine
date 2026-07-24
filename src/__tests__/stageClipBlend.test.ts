import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createClipBlend, type QuatCarrier } from '../services/stageClipBlend';

function bone(q: THREE.Quaternion): QuatCarrier {
  return { quaternion: q.clone() };
}
function rotZ(deg: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (deg * Math.PI) / 180);
}
function angleZ(q: THREE.Quaternion): number {
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return (e.z * 180) / Math.PI;
}

describe('createClipBlend', () => {
  it('eases from the captured start pose toward the clip pose (smoothstep)', () => {
    const A = rotZ(0);
    const B = rotZ(20);
    const b = bone(A);
    const blend = createClipBlend();
    blend.begin([b], 0.4); // capture A as the start
    b.quaternion.copy(B); // mixer.update wrote the clip pose B

    expect(blend.active).toBe(true);
    blend.apply(0.2); // t=0.5 → smoothstep(0.5)=0.5
    expect(angleZ(b.quaternion)).toBeCloseTo(10, 3); // halfway A→B
    expect(blend.active).toBe(true);
  });

  it('lands exactly on the clip pose and deactivates when complete', () => {
    const A = rotZ(0);
    const B = rotZ(30);
    const b = bone(A);
    const blend = createClipBlend();
    blend.begin([b], 0.3);
    b.quaternion.copy(B);
    const applied = blend.apply(0.3); // t=1
    expect(applied).toBe(true);
    expect(angleZ(b.quaternion)).toBeCloseTo(30, 3);
    expect(blend.active).toBe(false);
    // A subsequent apply is a no-op.
    b.quaternion.copy(rotZ(99));
    expect(blend.apply(0.1)).toBe(false);
    expect(angleZ(b.quaternion)).toBeCloseTo(99, 3); // untouched
  });

  it('leaves clip-untouched bones alone (slerp(from, from) is identity)', () => {
    const still = bone(rotZ(7));
    const blend = createClipBlend();
    blend.begin([still], 0.3);
    // mixer.update did NOT change this bone (clip has no track for it): stays at 7.
    blend.apply(0.15); // t=0.5
    expect(angleZ(still.quaternion)).toBeCloseTo(7, 3);
  });

  it('is inactive for empty bones or non-positive duration', () => {
    const blend = createClipBlend();
    blend.begin([], 0.3);
    expect(blend.active).toBe(false);
    blend.begin([bone(rotZ(0))], 0);
    expect(blend.active).toBe(false);
    expect(blend.apply(0.1)).toBe(false);
  });

  it('cancel() abandons an in-progress ease', () => {
    const b = bone(rotZ(0));
    const blend = createClipBlend();
    blend.begin([b], 0.5);
    expect(blend.active).toBe(true);
    blend.cancel();
    expect(blend.active).toBe(false);
    expect(blend.apply(0.1)).toBe(false);
  });
});
