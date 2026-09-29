import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, computeJointAngles } from '../services/jointAngles';
import { buildComposedCommandPose } from '../services/movementCommand';
import { buildSequencePoses, resolveComposedMotion, type SequenceTarget } from '../services/motionSequence';
import { rotateRestReferenceByRoot, rotateRestReferenceByPelvis } from '../services/rootMotion';
import { inspectShoulderComplex, type ShoulderComplexFrame } from '../services/shoulderComplex';
import baselineResults from './fixtures/shoulderComplex.directionalBaseline.json';

interface Case { id: string; flex: number; abd?: number; rotation?: number; tilt?: number; up?: number; protraction?: number; reverse?: boolean }
const cases: Case[] = [
  { id: 'neutral', flex: 0 }, { id: 'automatic-flex90', flex: 90 },
  { id: 'automatic-flex120', flex: 120 }, { id: 'automatic-flex180', flex: 180 },
  { id: 'explicit-zero-girdle-flex180', flex: 180, tilt: 0, up: 0, protraction: 0 },
  { id: 'explicit-tilt10-flex120-arm-first', flex: 120, tilt: 10 },
  { id: 'explicit-tilt10-flex120-girdle-first', flex: 120, tilt: 10, reverse: true },
  { id: 'combined-flex75-abd45-twist60', flex: 75, abd: 45, rotation: 60, protraction: 15 },
  { id: 'combined-flex75-abd45-twist-minus60', flex: 75, abd: 45, rotation: -60, protraction: 15 },
  { id: 'conflicting-flex120-abd45-twist30', flex: 120, abd: 45, rotation: 30 },
  { id: 'automatic-near-overhead179_9', flex: 179.9 },
  { id: 'neutral-axial60', flex: 0, rotation: 60 },
  { id: 'neutral-axial-minus60', flex: 0, rotation: -60 },
];
const frames = [
  { id: 'upright', root: [0, 0, 0], spine: [0, 0, 0] },
  { id: 'root-yaw67', root: [0, 67, 0], spine: [0, 0, 0] },
  { id: 'root-pitch90', root: [90, 0, 0], spine: [0, 0, 0] },
  { id: 'thoracic-flex30', root: [0, 0, 0], spine: [30, 0, 0] },
  { id: 'root-and-thoracic-combined', root: [25, 40, -15], spine: [25, 30, 15] },
];

for (const variant of ['male', 'female', 'neutral'] as const) describe(`${variant}: real shoulder-complex measurements`, () => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D, skin: THREE.SkinnedMesh;
  let bones: Map<string, THREE.Bone>;
  let reference: ReturnType<typeof captureJointAngleRestReference>;
  let baseline: ReturnType<typeof serializeCustomPose>;
  beforeAll(async () => {
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    root = gltf.scene; root.scale.setScalar(cfg.pose.rootScale); root.updateMatrixWorld(true);
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skin) skin = o as THREE.SkinnedMesh; });
    bones = buildBoneByPoseKey(skin.skeleton, cfg);
    reference = captureJointAngleRestReference(skin.skeleton, cfg);
    baseline = serializeCustomPose(skin.skeleton, cfg, variant);
  }, 60_000);
  function frame(side: string): ShoulderComplexFrame {
    const arm = bones.get(`${side}_UpperArm`)!, girdle = bones.get(`${side}_Shoulder`)!;
    return {
      armWorldDirection: bones.get(`${side}_Forearm`)!.getWorldPosition(new THREE.Vector3())
        .sub(arm.getWorldPosition(new THREE.Vector3())).normalize().toArray(),
      armWorldQuaternion: arm.getWorldQuaternion(new THREE.Quaternion()).toArray(),
      thoraxWorldQuaternion: girdle.parent!.getWorldQuaternion(new THREE.Quaternion()).toArray(),
      girdleWorldQuaternion: girdle.getWorldQuaternion(new THREE.Quaternion()).toArray(),
    };
  }
  function targets(c: Case, side: string): SequenceTarget[] {
    const result: SequenceTarget[] = [];
    for (const [motion, degrees] of [['shoulderFlexion', c.flex], ['shoulderAbduction', c.abd], ['shoulderRotation', c.rotation]] as const)
      if (degrees != null) result.push({ joint: `${side}_UpperArm`, motion, targetDegrees: degrees });
    for (const [motion, degrees] of [['scapularTilt', c.tilt], ['upRotation', c.up], ['protraction', c.protraction]] as const)
      if (degrees != null) result.push({ joint: `${side}_Shoulder`, motion, targetDegrees: degrees });
    return c.reverse ? result.reverse() : result;
  }

  for (const side of ['L', 'R'] as const) for (const c of cases) it(`${side}: ${c.id} retains measured direction under all five parent frames`, () => {
    root.quaternion.identity(); applyCustomPose(skin.skeleton, cfg, baseline); root.updateMatrixWorld(true);
    const rest = frame(side);
    const resolved = resolveComposedMotion({ startFrom: 'neutral', stance: 'floating',
      keyframes: [{ durationMs: 1000, targets: targets(c, side) }] }, cfg);
    expect(resolved.status).toBe('ok');
    const pose = buildSequencePoses(baseline, resolved, cfg, reference).poses[0]!;
    const expected = baselineResults.cases.find(r => r.variant === variant && r.side === side && r.case === c.id)!;
    let initial: ReturnType<typeof inspectShoulderComplex> | undefined;
    for (const f of frames) {
      const applied = buildComposedCommandPose(baseline, 'Spine_Upper', [
        { motion: 'flexion', degrees: f.spine[0]! }, { motion: 'rotation', degrees: f.spine[1]! },
        { motion: 'lateralTilt', degrees: f.spine[2]! },
      ], cfg, pose, reference)!;
      const rootDelta = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        f.root[0]! * Math.PI / 180, f.root[1]! * Math.PI / 180, f.root[2]! * Math.PI / 180, 'XYZ'));
      root.quaternion.copy(rootDelta); applyCustomPose(skin.skeleton, cfg, applied); root.updateMatrixWorld(true);
      for (const key of [`${side}_UpperArm`, `${side}_Shoulder`]) expect(applied.bones[key]).toEqual(pose.bones[key]);
      const result = inspectShoulderComplex({ side, current: frame(side), rest });
      expect(result.status, f.id).toBe('complete');
      expect(result.thorax.elevationDeg, f.id).toBeCloseTo(expected.thorax, 4);
      expect(result.girdleProxy.elevationDeg, f.id).toBeCloseTo(expected.proxy, 4);
      if (!initial) initial = result;
      else for (const key of ['thorax', 'girdleProxy'] as const) {
        // Production GLB matrix decomposition has microdegree roundoff under
        // parent transforms. These are numerical invariance tolerances, not
        // clinical ROM or motion-acceptance limits. Plane conditioning scales
        // inversely with the long axis's projection onto its tangent plane.
        const angularError = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
        expect(Math.abs(result[key].elevationDeg! - initial[key].elevationDeg!)).toBeLessThan(1e-5);
        if (initial[key].valid.plane) {
          expect(result[key].valid.plane).toBe(true);
          const projection = Math.sin(initial[key].elevationDeg! * Math.PI / 180);
          expect(angularError(result[key].planeOfElevationDeg!, initial[key].planeOfElevationDeg!))
            .toBeLessThan(1e-5 / Math.max(projection, 1e-7));
        }
        if (initial[key].valid.twist) {
          expect(result[key].valid.twist).toBe(true);
          expect(angularError(result[key].restAxisTwistDeg!, initial[key].restAxisTwistDeg!)).toBeLessThan(1e-5);
        }
      }
      if (c.id === 'automatic-flex180' || c.id === 'explicit-zero-girdle-flex180') expect(result.capacity.withinBudget).toBe(false);
      if (c.id.startsWith('explicit-tilt10')) expect(result.capacity.withinBudget).toBe(true);
      // Legacy fields retain their existing projected convention. Production
      // callers adjust ROOT then PELVIS; even that is not the live thorax frame.
      // Different angle conventions are not subtracted to invent a shortfall.
      const activeRest = rotateRestReferenceByPelvis(rotateRestReferenceByRoot(reference, rootDelta), skin.skeleton, cfg);
      const legacy = computeJointAngles(skin.skeleton, cfg, variant, activeRest).joints[`${side}_UpperArm`]!;
      expect(Object.values(legacy).every(Number.isFinite)).toBe(true);
    }
  });
});
