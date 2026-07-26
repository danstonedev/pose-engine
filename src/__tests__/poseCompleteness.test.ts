/**
 * ABSOLUTE POSES MUST BE ABSOLUTE.
 *
 * `applyCustomPose` is a PARTIAL write — bones a pose does not mention keep
 * whatever the skeleton was last left holding. That is invisible while every
 * writer emits the same key set, and every pose the stage generates does (they
 * all derive from the baseline via `copyPose`).
 *
 * It stops being invisible the moment the MAPPED BONE SET changes. Recordings
 * saved before the finger phalanges were mapped carry no keys for them, so
 * replaying such a frame after a newer motion left the digits curled inherits
 * that curl — and `fingerFlexion` reads the middle phalanx by child traversal,
 * not by map key, so the frame then MEASURES something it was never recorded as.
 *
 * This is the regression net for that: the same stored frame must measure the
 * same angle no matter what ran before it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { buildCommandPose, resolveCommandTarget } from '../services/movementCommand';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const PHALANX_KEY = /(Thumb|Index|Mid|Ring|Pinky)[23]$/;

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;

beforeAll(async () => {
  const url = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
  const buf = readFileSync(fileURLToPath(url));
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

/** A frame in the PRE-phalanx format: every key the old serializer emitted, and
 *  none of the ten it did not know about. */
function legacyFrame(): CustomPose {
  const bones: Record<string, [number, number, number, number]> = {};
  for (const [k, q] of Object.entries(baselinePose.bones ?? {}))
    if (!PHALANX_KEY.test(k)) bones[k] = [...q] as [number, number, number, number];
  return { ...baselinePose, bones };
}

function measure(pose: CustomPose): number {
  applyCustomPose(skinned.skeleton, variantCfg, pose);
  root.updateMatrixWorld(true);
  return computeJointAngles(skinned.skeleton, variantCfg, 'male', rest).joints.R_Mid1!
    .fingerFlexion;
}

/** What the stage's `applyPoseComplete` does: fill unmentioned bones from the
 *  baseline so an absolute pose is genuinely absolute. */
function complete(pose: CustomPose): CustomPose {
  return { ...pose, bones: { ...baselinePose.bones, ...pose.bones } };
}

describe('a pose that predates the mapped bone set still replays as recorded', () => {
  const curlTheDigits = () => {
    const cmd = { action: 'set-joint' as const, joint: 'R_Mid1', motion: 'fingerFlexion', targetDegrees: 120 };
    const r = resolveCommandTarget(cmd, variantCfg);
    const pose = buildCommandPose(baselinePose, cmd, r.clampedDegrees!, variantCfg, null, rest)!;
    return measure(pose);
  };

  it('the legacy frame is missing exactly the phalanx keys (the premise)', () => {
    const legacy = legacyFrame();
    const missing = Object.keys(baselinePose.bones ?? {}).filter((k) => !(k in legacy.bones!));
    expect(missing.length).toBe(20); // 5 digits × 2 phalanges × 2 hands
    expect(missing.every((k) => PHALANX_KEY.test(k))).toBe(true);
  });

  it('RAW applyCustomPose lets a prior motion leak into the replayed frame', () => {
    // The defect, pinned so the fix cannot be quietly reverted. This asserts the
    // BROKEN behaviour of the raw partial write — which is legitimate as the
    // underlying primitive; what must not happen is a stage replay using it.
    const legacy = legacyFrame();
    const clean = measure(legacy);
    expect(curlTheDigits()).toBeGreaterThan(100);
    const afterCurl = measure(legacy);
    expect(Math.abs(afterCurl - clean)).toBeGreaterThan(50); // rig-probed ≈ 74°
  });

  it('COMPLETED, the same frame measures the same angle whatever ran before it', () => {
    const legacy = legacyFrame();
    applyCustomPose(skinned.skeleton, variantCfg, baselinePose); // clean start
    const clean = measure(complete(legacy));
    curlTheDigits();
    expect(Math.abs(measure(complete(legacy)) - clean)).toBeLessThan(0.5);
    // …and from a deep curl in the other digits too.
    for (const digit of ['R_Index1', 'R_Ring1', 'R_Pinky1']) {
      const cmd = { action: 'set-joint' as const, joint: digit, motion: 'fingerFlexion', targetDegrees: 150 };
      const r = resolveCommandTarget(cmd, variantCfg);
      measure(buildCommandPose(baselinePose, cmd, r.clampedDegrees!, variantCfg, null, rest)!);
      expect(Math.abs(measure(complete(legacy)) - clean)).toBeLessThan(0.5);
    }
  });

  it('completing is a NO-OP for a current-format pose (no behaviour change)', () => {
    // Every pose the stage generates already carries every mapped bone, so the
    // overlay must be provably inert for them — otherwise this fix would be a
    // silent behaviour change to normal playback.
    const cmd = { action: 'set-joint' as const, joint: 'R_Mid1', motion: 'fingerFlexion', targetDegrees: 75 };
    const r = resolveCommandTarget(cmd, variantCfg);
    const pose = buildCommandPose(baselinePose, cmd, r.clampedDegrees!, variantCfg, null, rest)!;
    expect(complete(pose).bones).toEqual(pose.bones);
  });
});

describe('the stage never applies an absolute pose with the raw partial write', () => {
  const stageSource = readFileSync(
    fileURLToPath(new URL('../ExamStage3D.svelte', import.meta.url)),
    'utf8',
  );

  it('every skeleton-write goes through applyPoseComplete', () => {
    // One legitimate exception: the boot apply, which runs on a freshly anatomic
    // skeleton before the baseline ref exists, so unmentioned bones are already
    // at rest by construction.
    const raw = [...stageSource.matchAll(/applyCustomPose\(\s*(\w+)/g)].map((m) => m[1]);
    expect(raw).toEqual(['skinned', 'skeleton']); // boot apply + the helper itself
    expect(stageSource).toContain('function applyPoseComplete(');
    // The replay entry point specifically — the one that was rig-reproduced.
    expect(stageSource).toMatch(
      /showRecordedFrameImpl = \(frame: RecordedFrame\) => \{[\s\S]{0,600}applyPoseComplete\(/,
    );
  });
});
