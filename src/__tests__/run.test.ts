/**
 * buildRun — a real kinematic run has a FLIGHT phase where BOTH feet leave the
 * ground (unlike the in-place walk, which always keeps one foot planted). This is
 * the fix for "running doesn't leave the ground": the floating phases are not
 * floor-pinned, so the up-travel genuinely lifts the whole body clear of the floor.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { buildRun, templateToComposedMotion, MOVEMENT_TEMPLATES } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
});

const yOf = (rec: ReturnType<typeof sampleComposedMotion>, key: string): number[] =>
  rec.frames.map((f) => f.worldTracks![key]![1]);

describe('buildRun — a genuine flight phase (both feet leave the ground)', () => {
  it('has a frame where BOTH feet clear the floor (airborne), unlike the planted walk', () => {
    const runRec = sampleComposedMotion(resolveComposedMotion(buildRun(), variantCfg), {
      baselinePose,
      variantCfg,
      rest,
      skeletonHarness: { root, skinned },
      sampleHz: 60,
      loopCycle: true,
    });
    // At each frame the LOWER of the two feet, measured above the lowest planted
    // contact of the whole cycle. When that is high, BOTH feet are off the floor.
    const FLIGHT_M = 0.1; // "clearly airborne" — well above any gait swing-swap artifact
    const bothClear = (rec: ReturnType<typeof sampleComposedMotion>): { max: number; airborneFrames: number } => {
      const l = yOf(rec, 'L_Foot');
      const r = yOf(rec, 'R_Foot');
      const floor = Math.min(...l, ...r);
      let max = -Infinity;
      let airborneFrames = 0;
      for (let i = 0; i < rec.frames.length; i += 1) {
        const lo = Math.min(l[i]!, r[i]!) - floor;
        max = Math.max(max, lo);
        if (lo > FLIGHT_M) airborneFrames += 1;
      }
      return { max, airborneFrames };
    };

    const run = bothClear(runRec);
    // eslint-disable-next-line no-console
    console.log(`run: both feet clear the floor by up to ${(run.max * 100).toFixed(1)} cm; ${run.airborneFrames} airborne frames`);
    expect(run.max, 'both feet clearly airborne during flight').toBeGreaterThan(0.15);
    expect(run.airborneFrames, 'a sustained flight phase, not a one-frame blip').toBeGreaterThanOrEqual(3);

    // CONTRAST: the in-place walk always keeps a foot down. Its swing-swap does lift
    // both feet a few cm transiently, but it never reaches a true flight phase.
    const walkRec = sampleComposedMotion(
      resolveComposedMotion(templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!), variantCfg),
      { baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60, loopCycle: true },
    );
    const walk = bothClear(walkRec);
    expect(walk.airborneFrames, 'the walk never reaches a true flight phase').toBe(0);
  });
});
