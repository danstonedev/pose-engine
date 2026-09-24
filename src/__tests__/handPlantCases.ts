/**
 * THE HAND-PLANTED MOTIONS AGAINST 5c1c9ac — shared by handPlantMain.test.ts
 * and by the scratch run that measured 5c1c9ac's numbers into
 * fixtures/handPlant.5c1c9ac.json (this file, copied onto that tree: it only
 * uses what both trees have).
 *
 * Each case is a motion — or one part of a chain, sampled as the chain plays
 * it — recorded on a real rig at a rate, and measured the same way on both
 * trees:
 *  - each arm joint's fastest turn (°/frame) and its largest ONE-FRAME POP
 *    (a frame's turn less the larger of its neighbours' — a snap reads the
 *    same size at every rate, where a fast but smooth turn reads ~0);
 *  - each hand's and the centre of mass's largest second difference
 *    (mm/frame²) — a jump of the hand reads as twice its size;
 *  - how far each hand gets below the floor (m), and how far it travels
 *    along the floor (m) within 1.5 cm of its own lowest height;
 *  - the validity gate's seam-jerk (m/s; fails over 12).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { DEFAULT_TRACKED_BONES, sampleComposedMotion } from '../services/motionRecording';
import { sampleMotionChain } from '../services/movementChain';
import { captureFloorReference } from '../services/rootMotion';
import { assessValidity } from '../services/validityGate';
import {
  buildBirdDog,
  buildGetDownToPlank,
  buildGetDownToQuadruped,
  buildLowerToProne,
  buildPlankFromQuadruped,
  buildPressUpToQuadruped,
  buildPushUp,
  buildQuadrupedFromPlank,
  buildStandFromQuadruped,
} from '../services/movementPostures';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

export const HAND_RIGS = ['male', 'female'] as const;
export type HandRigVariant = (typeof HAND_RIGS)[number];
export const HAND_RATES = [30, 60, 120] as const;

export interface HandRig {
  variant: HandRigVariant;
  root: THREE.Object3D;
  skinned: THREE.SkinnedMesh;
  rest: JointAngleRestReference;
  baselinePose: CustomPose;
  floorY: number;
  rootRest0: THREE.Vector3;
  rootQuat0: THREE.Quaternion;
}

/** Load the `variant` rig: its GLB posed anatomically, with what sampling and
 *  measuring it needs. */
export async function loadHandRig(variant: HandRigVariant): Promise<HandRig> {
  const cfg = BODY_VARIANTS[variant];
  const url = new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url);
  const buf = readFileSync(fileURLToPath(url));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  const root = gltf.scene;
  root.scale.setScalar(cfg.pose.rootScale);
  let mesh: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, cfg);
  root.updateMatrixWorld(true);
  const skinned = mesh as unknown as THREE.SkinnedMesh;
  return {
    variant,
    root,
    skinned,
    rest: captureJointAngleRestReference(skinned.skeleton, cfg),
    baselinePose: serializeCustomPose(skinned.skeleton, cfg, variant),
    floorY: captureFloorReference(skinned.skeleton, cfg).floorY,
    rootRest0: root.position.clone(),
    rootQuat0: root.quaternion.clone(),
  };
}

/** A case: a motion sampled on its own, or part `part` of a chain. */
export interface HandCase {
  make: () => ComposedMotion | ComposedMotion[];
  part?: number;
}

/** The chain the prone press-up is played in (the round-4 catalog sweep's). */
const proneChain = (): ComposedMotion[] => [
  buildGetDownToQuadruped(),
  buildLowerToProne(),
  buildPressUpToQuadruped(),
  buildStandFromQuadruped(),
];
const plankProneChain = (): ComposedMotion[] => [
  buildGetDownToPlank(),
  buildLowerToProne(),
  buildPressUpToQuadruped(),
  buildStandFromQuadruped(),
];

export const HAND_CASES: Record<string, HandCase> = {
  // The bird-dog lets go of its left hand at 2742 and 5058 ms and replants it.
  'bird-dog-L3': { make: () => buildBirdDog({ side: 'L', reps: 3 }) },
  'bird-dog-L2': { make: () => buildBirdDog({ side: 'L', reps: 2 }) },
  // From quadruped (lowered to prone) back up: its hands self-heal.
  'prone-chain press-up': { make: proneChain, part: 2 },
  'plank-prone-chain press-up': { make: plankProneChain, part: 2 },
  // Sampled on their own, each drops from standing onto its hands: where the
  // hands land, and the arms catch the body.
  'bird-dog': { make: () => buildBirdDog() },
  'push-up': { make: () => buildPushUp() },
  'plank-from-quadruped': { make: () => buildPlankFromQuadruped() },
  'quadruped-from-plank': { make: () => buildQuadrupedFromPlank() },
  'press-up-to-quadruped': { make: () => buildPressUpToQuadruped() },
  // Lowering from hands and knees to prone, after getting down onto them: no
  // hand is planted, and the arms sweep back along the floor.
  'prone-chain lower-to-prone': { make: proneChain, part: 1 },
};

export const ARM_BONES = ['L_UpperArm', 'R_UpperArm', 'L_Forearm', 'R_Forearm'] as const;
export const HANDS = ['L_Hand', 'R_Hand'] as const;

/** What {@link measureHandCase} reads off one recording. */
export interface HandMeasure {
  /** Per arm joint: its fastest turn (°/frame) and largest one-frame pop (°). */
  arm: Record<string, { peak: number; pop: number }>;
  /** Per hand: largest second difference (mm/frame²), deepest below the floor
   *  (m), and travel along the floor within 1.5 cm of its lowest height (m). */
  hands: Record<string, { accel: number; depth: number; lowSlide: number }>;
  /** The centre of mass's largest second difference (mm/frame²). */
  comAccel: number;
  /** The validity gate's seam-jerk (m/s). */
  seamJerk: number;
}

const TRACKED = [...new Set([...DEFAULT_TRACKED_BONES, 'L_Hand', 'R_Hand'])];
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

interface Frame {
  tMs: number;
  pose: { bones: Record<string, number[]> };
  worldTracks?: Record<string, [number, number, number]>;
}

/** Record case `id` on `rig` at `hz` and measure it. */
export function measureHandCase(rig: HandRig, id: string, hz: number): HandMeasure {
  const c = HAND_CASES[id]!;
  const cfg = BODY_VARIANTS[rig.variant];
  rig.root.position.copy(rig.rootRest0);
  rig.root.quaternion.copy(rig.rootQuat0);
  rig.root.updateMatrixWorld(true);
  const options = {
    baselinePose: rig.baselinePose,
    variantCfg: cfg,
    rest: rig.rest,
    skeletonHarness: { root: rig.root, skinned: rig.skinned },
    sampleHz: hz,
    trackedBones: TRACKED,
  };
  const made = c.make();
  let frames: Frame[];
  let motion: ComposedMotion;
  if (Array.isArray(made)) {
    const parts = sampleMotionChain(made, options);
    const part = parts[c.part ?? 0]!;
    frames = part.recording.frames as unknown as Frame[];
    motion = part.motion;
  } else {
    motion = made;
    frames = sampleComposedMotion(resolveComposedMotion(made, cfg), options).frames as unknown as Frame[];
  }
  const n = frames.length;
  const arm: HandMeasure['arm'] = {};
  for (const bone of ARM_BONES) {
    const turn = [0];
    for (let i = 1; i < n; i += 1) {
      const a = frames[i - 1]!.pose.bones[bone]!;
      const b = frames[i]!.pose.bones[bone]!;
      turn.push((_qa.set(a[0]!, a[1]!, a[2]!, a[3]!).angleTo(_qb.set(b[0]!, b[1]!, b[2]!, b[3]!)) * 180) / Math.PI);
    }
    let peak = 0;
    let pop = 0;
    for (let i = 1; i < n; i += 1) {
      peak = Math.max(peak, turn[i]!);
      const nb = Math.max(i > 1 ? turn[i - 1]! : 0, i + 1 < n ? turn[i + 1]! : 0);
      pop = Math.max(pop, turn[i]! - nb);
    }
    arm[bone] = { peak, pop };
  }
  const accelOf = (key: string): number => {
    let a = 0;
    for (let i = 2; i < n; i += 1) {
      const p0 = frames[i - 2]!.worldTracks![key]!;
      const p1 = frames[i - 1]!.worldTracks![key]!;
      const p2 = frames[i]!.worldTracks![key]!;
      a = Math.max(a, 1000 * Math.hypot(p2[0] - 2 * p1[0] + p0[0], p2[1] - 2 * p1[1] + p0[1], p2[2] - 2 * p1[2] + p0[2]));
    }
    return a;
  };
  const hands: HandMeasure['hands'] = {};
  for (const key of HANDS) {
    const ys = frames.map((f) => f.worldTracks![key]![1]);
    const low = Math.min(...ys);
    let lowSlide = 0;
    for (let i = 1; i < n; i += 1) {
      if (ys[i]! > low + 0.015 || ys[i - 1]! > low + 0.015) continue;
      const p = frames[i]!.worldTracks![key]!;
      const q = frames[i - 1]!.worldTracks![key]!;
      lowSlide += Math.hypot(p[0] - q[0], p[2] - q[2]);
    }
    hands[key] = { accel: accelOf(key), depth: Math.max(0, rig.floorY - low), lowSlide };
  }
  const resolved = resolveComposedMotion(motion, cfg);
  const report = assessValidity(resolved, frames as never);
  const seam = report.checks.find((x) => x.id === 'seam-jerk');
  return { arm, hands, comAccel: accelOf('CoM'), seamJerk: seam ? seam.measured : 0 };
}
