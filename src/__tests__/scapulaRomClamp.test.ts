/**
 * The scapula's ROM clamp, calibrated against the engine's own girdle writer.
 *
 * The registry has defined scapular ranges all along — upRotation -5..60,
 * scapularTilt -10..40, protraction -30..30 — and `poseRomClamp` had no
 * strategy for L_/R_Shoulder, so `clampBoneToRom` returned false for it and
 * none of those bounds were ever enforced. Every neighbouring joint on the arm
 * has one, which is what made it a gap rather than a decision.
 *
 * ── Why these tests are round-trips ─────────────────────────────────────────
 *
 * Adding a clamp strategy means asserting which raw Euler axis carries which
 * clinical field, and in which direction. Get a sign wrong and the clamp is
 * worse than absent: it fights the user in the wrong plane and bounds anterior
 * tilt with the posterior limit. That risk is exactly what the engine's
 * calibration mode existed to hold off.
 *
 * So nothing here is eyeballed. `movementCommand` ALREADY writes this bone for
 * authored shoulder elevation (girdleSplit / writeGirdle) and its specs are the
 * engine's own statement of the convention. Each test writes a known clinical
 * value through those specs and asserts the clamp's readout reports the same
 * number back. If the two ever disagree, one of them is wrong and the pose path
 * and the motion path have diverged — which is the bug worth catching.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { buildBoneByPoseKey } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { clampBoneToRom, inspectClinicalAngles } from '../services/poseRomClamp';
import { buildCommandPose } from '../services/movementCommand';
import { serializeCustomPose } from '../services/poseRig';
import { getRomJointDefinition } from '../services/romRegistry';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let skeleton: THREE.Skeleton;
let rest: JointAngleRestReference;
let byKey: Map<string, THREE.Bone>;

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  const root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  let skinned: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  skeleton = (skinned as unknown as THREE.SkinnedMesh).skeleton;
  rest = captureJointAngleRestReference(skeleton, variantCfg);
  byKey = buildBoneByPoseKey(skeleton, variantCfg);
  baselinePose = serializeCustomPose(skeleton, variantCfg, 'male');
});

const DEG = Math.PI / 180;

let baselinePose: ReturnType<typeof serializeCustomPose>;

/**
 * Write a scapular value through the engine's OWN writer, then read it back
 * through the clamp's decomposition.
 *
 * `buildCommandPose` is the public path `movementCommand` uses for authored
 * motion, so nothing in this round-trip is a re-derivation of the convention —
 * if the two paths disagree about what "45 degrees of upward rotation" means,
 * that is the finding, and it fails here.
 */
function roundTrip(
  key: 'L_Shoulder' | 'R_Shoulder',
  field: 'upRotation' | 'scapularTilt' | 'protraction',
  deg: number,
): { clinicalFlexion: number; rawAbduction: number; rawRotation: number } {
  const posed = buildCommandPose(
    baselinePose,
    { joint: key, motion: field, action: 'move' } as never,
    deg,
    variantCfg,
    null,
    rest,
  );
  if (!posed) throw new Error(`${key}.${field} is not a supported command`);
  const written = posed.bones?.[key];
  if (!written) throw new Error(`${key}.${field} wrote no ${key} rotation`);

  const bone = byKey.get(key)!;
  const before = bone.quaternion.clone();
  try {
    bone.quaternion.set(written[0], written[1], written[2], written[3]);
    bone.updateMatrixWorld(true);
    const report = inspectClinicalAngles(bone, key, rest)!;
    return {
      clinicalFlexion: report.anatomicFlexion,
      rawAbduction: report.raw.abduction,
      rawRotation: report.raw.rotation,
    };
  } finally {
    bone.quaternion.copy(before);
    bone.updateMatrixWorld(true);
  }
}

/**
 * The clinical frontal value, straight off the report.
 *
 * `ClinicalAnglesReport.raw` is named "raw" but for a BODY-EULER joint it is
 * already mirror- and sign-applied: `inspectClinicalAngles` does
 * `if (strategy.mirror) abd = -abd` before storing it. So this is the identity,
 * and flipping again here double-applies the mirror. For a ball-joint the name
 * is accurate, which is exactly what makes this easy to get wrong.
 *
 * Underneath, the measured relation is: the engine's writer at +d yields a raw
 * decomposition of +d on the left and -d on the right, linearly from -30 to
 * 140 degrees. That is why the right strategy carries `mirror: true` — without
 * it the registry's asymmetric -5..60 bound lands on the downward pole.
 */
function clinicalUpRotation(_key: 'L_Shoulder' | 'R_Shoulder', rawAbduction: number): number {
  return rawAbduction;
}

describe('the scapula now has a clamp strategy', () => {
  it.each(['L_Shoulder', 'R_Shoulder'] as const)('%s reports clinical angles', (key) => {
    // Previously null — no strategy, so `clampBoneToRom` returned false and the
    // registry's scapular ranges were never enforced.
    expect(inspectClinicalAngles(byKey.get(key)!, key, rest)).not.toBeNull();
  });

  it('reads the registry ranges the scapula already had', () => {
    const report = inspectClinicalAngles(byKey.get('L_Shoulder')!, 'L_Shoulder', rest)!;
    expect(report.strategy).toBe('body-euler');
    expect(report.ranges.flexion).toEqual({ min: -10, max: 40 }); // scapularTilt
    expect(report.ranges.abduction).toEqual({ min: -5, max: 60 }); // upRotation
    expect(report.ranges.rotation).toEqual({ min: -30, max: 30 }); // protraction
    // …and those ranges are the registry's, not numbers invented here.
    const def = getRomJointDefinition('L_Shoulder')!;
    expect(def.fields.find((f) => f.key === 'upRotation')!.range).toEqual({ min: -5, max: 60 });
  });
});

describe('the clamp agrees with the girdle writer, axis for axis', () => {
  // If these disagree, the interactive pose path and the authored motion path
  // have diverged on what a scapula angle means — which is the bug worth
  // catching, and the reason the strategy was derived from this writer rather
  // than guessed.
  for (const key of ['L_Shoulder', 'R_Shoulder'] as const) {
    it(`${key}: tilt round-trips with the right sign`, () => {
      // Asymmetric range (-10..40), so the sign genuinely matters: a flipped
      // one would bound anterior tilt with the posterior limit.
      expect(roundTrip(key, 'scapularTilt', 25).clinicalFlexion).toBeCloseTo(25, 1);
      expect(roundTrip(key, 'scapularTilt', -8).clinicalFlexion).toBeCloseTo(-8, 1);
    });

    it(`${key}: upward rotation round-trips with the right sign`, () => {
      // Also asymmetric (-5..60). This is the axis where the mirror flag earns
      // its keep — the right clavicle's rest is mirrored, so the raw
      // decomposition reads the opposite sign and the strategy has to undo it.
      const { rawAbduction } = roundTrip(key, 'upRotation', 45);
      expect(clinicalUpRotation(key, rawAbduction)).toBeCloseTo(45, 1);
    });

    it(`${key}: protraction round-trips in magnitude`, () => {
      // The one axis this strategy shape cannot sign — `mirror` flips only the
      // abduction source and there is no rotationSign. Harmless while the range
      // is symmetric (-30..30), which is why magnitude is what is asserted.
      expect(Math.abs(roundTrip(key, 'protraction', 20).rawRotation)).toBeCloseTo(20, 1);
    });
  }
});

describe('the clamp actually holds the scapula', () => {
  it.each(['L_Shoulder', 'R_Shoulder'] as const)('%s stops at the upward-rotation limit', (key) => {
    // Driven through the engine's writer at 140 degrees, so the starting
    // position is a real over-rotation rather than a raw quaternion this test
    // invented — and asserted OUT of range before clamping, so the assertion
    // after cannot pass vacuously.
    const posed = buildCommandPose(
      baselinePose,
      { joint: key, motion: 'upRotation', action: 'move' } as never,
      140,
      variantCfg,
      null,
      rest,
    )!;
    const written = posed.bones![key]!;
    const bone = byKey.get(key)!;
    const before = bone.quaternion.clone();
    try {
      bone.quaternion.set(written[0], written[1], written[2], written[3]);
      bone.updateMatrixWorld(true);
      const overRotated = clinicalUpRotation(key, inspectClinicalAngles(bone, key, rest)!.raw.abduction);
      expect(overRotated).toBeGreaterThan(60);

      expect(clampBoneToRom(bone, key, rest)).toBe(true);
      bone.updateMatrixWorld(true);
      const held = clinicalUpRotation(key, inspectClinicalAngles(bone, key, rest)!.raw.abduction);
      expect(held).toBeLessThanOrEqual(60 + 0.5);
      expect(held).toBeGreaterThan(55);
    } finally {
      bone.quaternion.copy(before);
      bone.updateMatrixWorld(true);
    }
  });

  it('leaves an in-range scapula alone', () => {
    const posed = buildCommandPose(
      baselinePose,
      { joint: 'L_Shoulder', motion: 'upRotation', action: 'move' } as never,
      30,
      variantCfg,
      null,
      rest,
    )!;
    const written = posed.bones!.L_Shoulder!;
    const bone = byKey.get('L_Shoulder')!;
    const before = bone.quaternion.clone();
    try {
      bone.quaternion.set(written[0], written[1], written[2], written[3]);
      const applied = bone.quaternion.clone();
      expect(clampBoneToRom(bone, 'L_Shoulder', rest)).toBe(false);
      expect(bone.quaternion.angleTo(applied)).toBeLessThan(1e-6);
    } finally {
      bone.quaternion.copy(before);
      bone.updateMatrixWorld(true);
    }
  });
});
