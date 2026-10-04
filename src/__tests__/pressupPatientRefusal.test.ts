import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { setRomClampEnabled } from '../services/poseRomClamp';
import { pressupPatientRangeRefusal } from '../services/pressupPatientSupport';
import type { RomScenarioConstraints } from '../services/romConstraints';

const severe: RomScenarioConstraints = Object.fromEntries(['L', 'R'].flatMap(side => [
  [`${side}_Forearm`, { elbowFlexion: { availableRange: { min: 35, max: 75 } } }],
  [`${side}_Hand`, { wristFlexion: { availableRange: { min: -35, max: 35 } } }],
  [`${side}_Leg`, { kneeFlexion: { availableRange: { min: 0, max: 0 } } }],
]));
const feasible: RomScenarioConstraints = Object.fromEntries(['L', 'R'].flatMap(side => [
  [`${side}_Forearm`, { elbowFlexion: { availableRange: { min: 10, max: 145 } } }],
  [`${side}_Hand`, { wristFlexion: { availableRange: { min: -65, max: 60 } } }],
]));
const reason = 'Left elbow limits (35–75°) do not allow the extension required for this press-up.';

describe.each(['male', 'female', 'neutral'] as const)('%s prepared press-up patient refusal', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D, skinned: THREE.SkinnedMesh;
  let baselinePose: ReturnType<typeof serializeCustomPose>, rest: ReturnType<typeof captureJointAngleRestReference>;
  beforeAll(async () => {
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
    baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant); rest = captureJointAngleRestReference(skinned.skeleton, cfg);
  });
  afterEach(() => setRomClampEnabled(null));
  const snapshot = () => [root.position.toArray(), root.quaternion.toArray(), root.scale.toArray(),
    ...skinned.skeleton.bones.map(bone => [bone.position.toArray(), bone.quaternion.toArray(), bone.scale.toArray()])];
  const options = () => ({ baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz: 1 });

  it('refuses known unsupported limits during resolution and retains the reason in recording', () => {
    setRomClampEnabled(false);
    const motion = BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R');
    const resolved = resolveComposedMotion(motion, cfg, { constraints: severe });
    expect(resolved.status).toBe('refused'); expect(resolved.reason).toBe(reason);
    const before = snapshot(), recording = sampleComposedMotion(resolved, options());
    expect(recording.frames).toEqual([]); expect(recording.refusalReason).toBe(reason);
    expect(snapshot()).toEqual(before);
  });
  it('refuses runtime-only patient limits without mutating any rig transform', () => {
    setRomClampEnabled(false);
    const resolved = resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg);
    expect(resolved.status).toBe('ok');
    const before = snapshot(), recording = sampleComposedMotion(resolved, { ...options(), constraints: severe });
    expect(recording.frames).toEqual([]); expect(recording.refusalReason).toBe(reason);
    expect(snapshot()).toEqual(before);
  });
  it('preserves default and endpoint-compatible patient requests without claiming physical qualification', () => {
    const motion = BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R');
    for (const constraints of [undefined, feasible]) {
      const resolved = resolveComposedMotion(motion, cfg, { constraints });
      expect(resolved.status).toBe('ok'); expect(resolved.reason).toBeUndefined();
      expect(pressupPatientRangeRefusal(resolved, constraints)).toBeUndefined();
    }
    expect(pressupPatientRangeRefusal({ ...motion, pronePalmAnchorFit: false }, severe)).toBeUndefined();
  });
});
