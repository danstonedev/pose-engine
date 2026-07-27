/**
 * SELF-INTERSECTION — the body must not pass through itself.
 *
 * WHY THIS EXISTS. Reported from the deployed build: the model's fingers and
 * hands moved *through* its legs during swing. Every gate in this engine was
 * green at the time, and every one of them could have stayed green forever,
 * because they all measured ANGLES. A pose can sit inside every ROM band,
 * perfectly phased, perfectly grounded, and still put the hand in the same cubic
 * centimetres as the thigh. Joint-space validity and VOLUMETRIC validity are
 * different claims and only the first was being made.
 *
 * IT WAS NOT A REGRESSION, which is worth recording because it was assumed to be
 * one. Per-vertex measurement of the travel walk:
 *
 *     before the movement-realism work (ffd1b76)   0.27 cm
 *     after it, as deployed                        0.57 cm
 *     after the arm-carriage fix in this change    6.09 cm
 *
 * Both of the first two are "touching" — the defect predated the work that got
 * blamed for it, and that work had in fact moved the number slightly the right
 * way. What changed was that other things stopped being distracting.
 *
 * THIS FILE HAS THREE JOBS, and the middle one is the load-bearing one:
 *   1. Re-derive the capsule radii from the rig, so the model cannot silently
 *      drift away from the mesh it claims to approximate.
 *   2. VALIDATE THE CAPSULE MODEL AGAINST PER-VERTEX GROUND TRUTH. A cheap
 *      approximation used as a gate is only as good as its agreement with the
 *      thing it approximates, and asserting that agreement is what separates
 *      this from a plausible-looking guess.
 *   3. Gate the shipped gaits.
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
  type JointAngleRestReference,
} from '../services/jointAngles';
import { resolveComposedMotion, buildSequencePoses } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import {
  measureLimbClearance,
  segmentDistance,
  LIMB_SEGMENTS,
  THIGH_RADIUS_M,
  SHANK_RADIUS_M,
  FOREARM_RADIUS_M,
  HAND_RADIUS_M,
  type Vec3,
} from '../services/limbClearance';
import { buildTravelWalk, buildTravelRun } from '../services/movementLocomotion';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let meshes: THREE.SkinnedMesh[] = [];
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
const sampled: Record<string, MotionRecording> = {};

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
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
      meshes.push(o as THREE.SkinnedMesh);
      if (!skinned) skinned = o as THREE.SkinnedMesh;
    }
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  for (const [name, motion] of [
    ['walk', buildTravelWalk()],
    ['run', buildTravelRun()],
  ] as const) {
    const resolved = resolveComposedMotion(motion, variantCfg);
    expect(resolved.status, `${name} resolves`).toBe('ok');
    sampled[name] = sampleComposedMotion(resolved, {
      baselinePose,
      variantCfg,
      rest,
      skeletonHarness: { root, skinned },
      sampleHz: 120,
    });
  }
}, 300_000);

const tracksOf = (rec: MotionRecording) =>
  rec.frames.map((f) => (f.worldTracks ?? {}) as Record<string, Vec3>);

/** Dominantly-weighted vertex indices per bone-name predicate, across ALL meshes.
 *  There are SIX skinned meshes sharing one 101-bone skeleton — taking only the
 *  first finds no hand or leg vertices at all. */
const vertsMatching = (re: RegExp): { mesh: THREE.SkinnedMesh; i: number }[] => {
  const out: { mesh: THREE.SkinnedMesh; i: number }[] = [];
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position!;
    const si = mesh.geometry.attributes.skinIndex!;
    const sw = mesh.geometry.attributes.skinWeight!;
    const names = mesh.skeleton.bones.map((b) => b.name);
    for (let i = 0; i < pos.count; i += 1) {
      let best = -1;
      let bw = -1;
      for (let k = 0; k < 4; k += 1) {
        const w = sw.getComponent(i, k);
        if (w > bw) {
          bw = w;
          best = si.getComponent(i, k);
        }
      }
      if (re.test(names[best] ?? '')) out.push({ mesh, i });
    }
  }
  return out;
};

const worldOfVerts = (refs: { mesh: THREE.SkinnedMesh; i: number }[]): THREE.Vector3[] => {
  const tmp = new THREE.Vector3();
  return refs.map(({ mesh, i }) => {
    tmp.fromBufferAttribute(mesh.geometry.attributes.position!, i);
    mesh.applyBoneTransform(i, tmp);
    return mesh.localToWorld(tmp.clone());
  });
};

const HAND_RE = /_(Hand|Index[123]|Mid[123]|Ring[123]|Pinky[123]|Thumb[123])$/;
const LEG_RE = /_(Thigh|Calf|ThighTwist\d+|CalfTwist\d+)$/;

describe('the capsule radii still describe this rig', () => {
  it('re-derives each from the bind mesh', () => {
    // Pins the model to the ASSET. If the GLB is re-exported with different
    // proportions these constants become fiction, and a gate built on fiction
    // passes for the wrong reason.
    //
    // RETURN TO REST FIRST. `beforeAll` samples two gaits, and sampling leaves
    // the skeleton in whatever pose it finished on — measuring a "bind pose"
    // radius off a mid-stride thigh reads 0.1043 instead of 0.1027, which is a
    // small enough error to look like tolerance rather than a mistake.
    applyCustomPose(skinned.skeleton, variantCfg, baselinePose);
    root.updateMatrixWorld(true);
    const bone = new Map(skinned.skeleton.bones.map((b) => [b.name, b]));
    const wp = (n: string) => {
      const b = bone.get(n);
      if (!b) return null;
      const v = new THREE.Vector3();
      b.getWorldPosition(v);
      return v;
    };
    const distToSeg = (p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) => {
      const abv = b.clone().sub(a);
      const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(abv) / Math.max(1e-9, abv.lengthSq())));
      return p.distanceTo(a.clone().addScaledVector(abv, t));
    };
    const p90 = (re: RegExp, from: string, to: string) => {
      const a = wp(from)!;
      const b = wp(to)!;
      const ds = worldOfVerts(vertsMatching(re)).map((v) => distToSeg(v, a, b)).sort((x, y) => x - y);
      return ds[Math.floor(ds.length * 0.9)]!;
    };
    const cases: [string, number, number][] = [
      ['thigh', p90(/_L_(Thigh|ThighTwist\d+)$/, 'CC_Base_L_Thigh', 'CC_Base_L_Calf'), THIGH_RADIUS_M],
      ['shank', p90(/_L_(Calf|CalfTwist\d+)$/, 'CC_Base_L_Calf', 'CC_Base_L_Foot'), SHANK_RADIUS_M],
      ['forearm', p90(/_L_(Forearm|ForearmTwist\d+)$/, 'CC_Base_L_Forearm', 'CC_Base_L_Hand'), FOREARM_RADIUS_M],
      ['hand', p90(/_L_(Hand|Index[123]|Mid[123]|Ring[123]|Pinky[123]|Thumb[123])$/, 'CC_Base_L_Hand', 'CC_Base_L_Mid2'), HAND_RADIUS_M],
    ];
    for (const [name, measured, declared] of cases) {
      // eslint-disable-next-line no-console
      console.log(`radius ${name.padEnd(8)} measured ${measured.toFixed(4)} m · declared ${declared.toFixed(4)} m`);
      expect(measured, `${name} radius still matches the rig`).toBeCloseTo(declared, 3);
    }
  }, 300_000);
});

describe('the capsule model agrees with per-vertex ground truth', () => {
  it('is CONSERVATIVE — it never reports more clearance than the mesh really has', () => {
    // THE LOAD-BEARING TEST. The gate is cheap because it uses capsules; it is
    // trustworthy only if those capsules do not over-report clearance. Under-
    // reporting is fine and expected (p90 radii plus a straight-line segment
    // through a curved limb) — it makes the gate flag early. OVER-reporting
    // would let a real interpenetration through, which is the whole failure this
    // exists to prevent.
    const H = vertsMatching(HAND_RE);
    const L = vertsMatching(LEG_RE);
    const step = <T,>(a: T[], n: number) => a.filter((_, i) => i % Math.max(1, Math.floor(a.length / n)) === 0);
    const hs = step(H, 220);
    const ls = step(L, 420);

    const resolved = resolveComposedMotion(buildTravelWalk(), variantCfg);
    const poses = buildSequencePoses(baselinePose, resolved, variantCfg, rest).poses;
    const boneByKey = new Map(skinned.skeleton.bones.map((b) => [b.name, b]));
    const keyToBone: Record<string, string> = {
      L_UpLeg: 'CC_Base_L_Thigh', R_UpLeg: 'CC_Base_R_Thigh',
      L_Leg: 'CC_Base_L_Calf', R_Leg: 'CC_Base_R_Calf',
      L_Foot: 'CC_Base_L_Foot', R_Foot: 'CC_Base_R_Foot',
      L_Forearm: 'CC_Base_L_Forearm', R_Forearm: 'CC_Base_R_Forearm',
      L_Hand: 'CC_Base_L_Hand', R_Hand: 'CC_Base_R_Hand',
      L_Mid1: 'CC_Base_L_Mid1', R_Mid1: 'CC_Base_R_Mid1',
    };

    let worstVertex = Infinity;
    let worstCapsule = Infinity;
    for (const p of poses) {
      applyCustomPose(skinned.skeleton, variantCfg, p);
      root.updateMatrixWorld(true);
      const hp = worldOfVerts(hs);
      const lp = worldOfVerts(ls);
      for (const a of hp) for (const b of lp) worstVertex = Math.min(worstVertex, a.distanceTo(b));

      const tracks: Record<string, Vec3> = {};
      for (const [key, boneName] of Object.entries(keyToBone)) {
        const b = boneByKey.get(boneName);
        if (!b) continue;
        const v = new THREE.Vector3();
        b.getWorldPosition(v);
        tracks[key] = [v.x, v.y, v.z];
      }
      worstCapsule = Math.min(worstCapsule, measureLimbClearance([tracks]).worstM);
    }
    // eslint-disable-next-line no-console
    console.log(
      `\nwalk keyframe poses — per-VERTEX minimum ${(worstVertex * 100).toFixed(2)} cm · ` +
        `CAPSULE minimum ${(worstCapsule * 100).toFixed(2)} cm ` +
        `(capsule is ${((worstVertex - worstCapsule) * 100).toFixed(2)} cm conservative)`,
    );
    expect(worstCapsule, 'the capsule model never over-reports clearance').toBeLessThanOrEqual(
      worstVertex + 1e-6,
    );
  }, 600_000);
});

describe('the shipped gaits do not pass through themselves', () => {
  it('reports limb clearance for walk and run', () => {
    for (const g of ['walk', 'run'] as const) {
      const rep = measureLimbClearance(tracksOf(sampled[g]!));
      // eslint-disable-next-line no-console
      console.log(
        `\n[${g}] worst ${(rep.worstM * 100).toFixed(2)} cm\n` +
          rep.findings
            .slice(0, 4)
            .map((f) => `    ${f.pair.padEnd(22)} ${(f.clearanceM * 100).toFixed(2)} cm @ ${f.framePct.toFixed(0)}%`)
            .join('\n'),
      );
    }
  }, 300_000);

  it('NOTHING interpenetrates, on either gait', () => {
    // The reported defect as a gate. The walk measured −2.85 cm of hand↔thigh
    // interpenetration before the arm carriage was corrected.
    for (const g of ['walk', 'run'] as const) {
      const rep = measureLimbClearance(tracksOf(sampled[g]!));
      expect(rep.untracked, `${g} — every pair measurable`).toEqual([]);
      expect(rep.worstM, `${g} limb clearance`).toBeGreaterThan(0.01);
    }
  }, 300_000);

  it('every pair is actually MEASURABLE — an unseen pair is not a passing pair', () => {
    // The mechanism that let this ship. `measureLimbClearance` reports untracked
    // pairs rather than skipping them, and DEFAULT_TRACKED_BONES carries the
    // knees/elbows/knuckles it needs. If someone trims that list to save bytes,
    // this fails instead of quietly measuring nothing.
    for (const g of ['walk', 'run'] as const) {
      const rep = measureLimbClearance(tracksOf(sampled[g]!));
      expect(rep.findings.length, `${g} measured every pair`).toBe(LIMB_SEGMENTS.length);
    }
  }, 300_000);
});

describe('segmentDistance', () => {
  it('handles the degenerate cases the hand capsule actually hits', () => {
    const P: Vec3 = [0, 0, 0];
    // Parallel, offset by 1 in y.
    expect(segmentDistance([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0])).toBeCloseTo(1, 6);
    // Crossing segments meet at the origin.
    expect(segmentDistance([-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0])).toBeCloseTo(0, 6);
    // A zero-length segment degenerates to point-to-segment — the hand capsule
    // is barely longer than its own radius, so this path is live in production.
    expect(segmentDistance(P, P, [0, 2, 0], [0, 3, 0])).toBeCloseTo(2, 6);
    expect(segmentDistance(P, P, [5, 5, 5], [5, 5, 5])).toBeCloseTo(Math.sqrt(75), 6);
    // Endpoint-clamped: nearest approach is off the end of both.
    expect(segmentDistance([0, 0, 0], [1, 0, 0], [3, 0, 0], [4, 0, 0])).toBeCloseTo(2, 6);
  });
});
