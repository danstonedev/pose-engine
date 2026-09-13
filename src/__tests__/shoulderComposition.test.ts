import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, computeJointAngles } from '../services/jointAngles';
import { buildComposedCommandPose, type ComposedJointTarget } from '../services/movementCommand';
import { buildSequencePoses, resolveComposedMotion } from '../services/motionSequence';

// Read the actual shoulder-to-elbow axis. A numeric readout alone cannot catch
// a pose mirrored into the wrong hemisphere (the original tan construction).
describe.each(['male', 'female'] as const)('%s composed shoulder geometry', (variant) => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D;
  let skeleton: THREE.Skeleton;
  let bones: Map<string, THREE.Bone>;
  let baseline: ReturnType<typeof serializeCustomPose>;
  let rest: ReturnType<typeof captureJointAngleRestReference>;

  beforeAll(async () => {
    const buf = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    root = gltf.scene;
    root.scale.setScalar(cfg.pose.rootScale);
    root.traverse(o => {
      if (!skeleton && (o as THREE.SkinnedMesh).isSkinnedMesh) skeleton = (o as THREE.SkinnedMesh).skeleton;
    });
    root.updateMatrixWorld(true);
    applyAnatomicPose(root, cfg);
    root.updateMatrixWorld(true);
    bones = buildBoneByPoseKey(skeleton, cfg);
    rest = captureJointAngleRestReference(skeleton, cfg);
    baseline = serializeCustomPose(skeleton, cfg, variant);
  });

  function apply(side: 'L' | 'R', targets: ComposedJointTarget[]): THREE.Vector3 {
    const pose = buildComposedCommandPose(baseline, `${side}_UpperArm`, targets, cfg, null, rest)!;
    expect(pose).not.toBeNull();
    applyCustomPose(skeleton, cfg, pose);
    root.updateMatrixWorld(true);
    return bones.get(`${side}_Forearm`)!.getWorldPosition(new THREE.Vector3())
      .sub(bones.get(`${side}_UpperArm`)!.getWorldPosition(new THREE.Vector3())).normalize();
  }

  it.each(['L', 'R'] as const)('%s: adding a zero shoulder field preserves the single-plane reach', side => {
    for (const motion of ['shoulderFlexion', 'shoulderAbduction']) {
      const other = motion === 'shoulderFlexion' ? 'shoulderAbduction' : 'shoulderFlexion';
      for (const degrees of [-30, 0, 45, 89, 90, 91, 120, 160, 170, 180]) {
        const single = apply(side, [{ motion, degrees }]);
        for (const extra of [other, 'shoulderRotation']) {
          const composed = apply(side, [{ motion, degrees }, { motion: extra, degrees: 0 }]);
          expect(composed.distanceTo(single), `${side} ${motion}=${degrees}, ${extra}=0`).toBeLessThan(1e-6);
        }
      }
    }
  });

  it.each(['L', 'R'] as const)('%s: reconstructs compatible projected angles in every spatial quadrant', side => {
    const s = side === 'R' ? -1 : 1;
    const rd = new THREE.Vector3(...rest.worldDirs![`${side}_UpperArm`]);
    const f0 = Math.atan2(rd.z, -rd.y);
    const a0 = Math.atan2(s * rd.x, -rd.y);
    // Generate independent world directions, then derive their two projections.
    // Arbitrary F x A pairs can disagree about the sign of Y; those do not
    // describe a possible arm direction and are not a full-sphere test.
    for (const elevation of [5, 45, 89, 91, 120, 170, 175]) {
      for (const azimuth of [-175, -135, -90, -45, -5, 5, 45, 90, 135, 175]) {
        const e = elevation * Math.PI / 180;
        const a = azimuth * Math.PI / 180;
        const wanted = new THREE.Vector3(s * Math.sin(e) * Math.sin(a), -Math.cos(e), Math.sin(e) * Math.cos(a));
        const actual = apply(side, [
          { motion: 'shoulderFlexion', degrees: (Math.atan2(wanted.z, -wanted.y) - f0) * 180 / Math.PI },
          { motion: 'shoulderAbduction', degrees: (Math.atan2(s * wanted.x, -wanted.y) - a0) * 180 / Math.PI },
        ]);
        expect(actual.distanceTo(wanted), `${side}: elevation ${elevation}, azimuth ${azimuth}`).toBeLessThan(1e-6);
      }
    }
  });

  it.each(['L', 'R'] as const)('%s: the authored 170-degree reach stays overhead through sequence building', side => {
    const joint = `${side}_UpperArm`;
    const resolved = resolveComposedMotion({
      name: 'overhead composition regression',
      startFrom: 'neutral',
      keyframes: [{ durationMs: 1000, targets: [
        { joint, motion: 'shoulderFlexion', targetDegrees: 170 },
        { joint, motion: 'shoulderAbduction', targetDegrees: 0 },
      ] }],
    }, cfg);
    expect(resolved.status).toBe('ok');
    const built = buildSequencePoses(baseline, resolved, cfg, rest);
    applyCustomPose(skeleton, cfg, built.poses[0]);
    root.updateMatrixWorld(true);
    const shoulder = bones.get(joint)!.getWorldPosition(new THREE.Vector3());
    const elbow = bones.get(`${side}_Forearm`)!.getWorldPosition(new THREE.Vector3());
    expect(elbow.y).toBeGreaterThan(shoulder.y + 0.1);
    const angles = computeJointAngles(skeleton, cfg, variant, rest);
    expect(angles.joints[joint].shoulderFlexion).toBeCloseTo(170, 5);
    // The serialized GLB/rest-quaternion round trip leaves microdegree noise.
    expect(Math.abs(angles.joints[joint].shoulderRotation)).toBeLessThan(1e-4);
  });

  it.each(['L', 'R'] as const)('%s: horizontal projections remain finite and preserve their signed directions', side => {
    const s = side === 'R' ? -1 : 1;
    const rd = new THREE.Vector3(...rest.worldDirs![`${side}_UpperArm`]);
    for (const forward of [-1, 1]) {
      for (const lateral of [-1, 1]) {
        const actual = apply(side, [
          { motion: 'shoulderFlexion', degrees: forward * 90 - Math.atan2(rd.z, -rd.y) * 180 / Math.PI },
          { motion: 'shoulderAbduction', degrees: lateral * 90 - Math.atan2(s * rd.x, -rd.y) * 180 / Math.PI },
        ]);
        expect(actual.distanceTo(new THREE.Vector3(s * lateral, 0, forward).normalize())).toBeLessThan(1e-6);
      }
    }
  });

  it.each(['L', 'R'] as const)('%s: conflicting projections retain the overhead, forward and lateral intent', side => {
    // 120 flexion and 20 abduction cannot both read back as projected angles:
    // one asks for positive Y, the other negative Y. Elevation takes priority;
    // this is a direction check, deliberately not an exact-angle claim.
    const actual = apply(side, [
      { motion: 'shoulderFlexion', degrees: 120 },
      { motion: 'shoulderAbduction', degrees: 20 },
    ]);
    expect(actual.y).toBeGreaterThan(0);
    expect(actual.z).toBeGreaterThan(0);
    expect(actual.x * (side === 'R' ? -1 : 1)).toBeGreaterThan(0);
  });
});
