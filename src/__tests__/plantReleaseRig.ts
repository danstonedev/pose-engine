/**
 * The real male rig and the release measurements the plant-release rig tests
 * share (plantReleaseSpeed, plantReleaseStance, plantReleaseWalks) — one file
 * held all of them and ran 62–75 s on a loaded machine.
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion, type ComposedMotion, type ResolvedComposedMotion } from '../services/motionSequence';
import {
  authoredToTrajectoryTimeScale,
  sampleComposedMotion,
  type MotionRecording,
} from '../services/motionRecording';
import { buildTravelWalk } from '../services/movementLocomotion';
import { captureFloorReference } from '../services/rootMotion';
import { BODY_VARIANTS, type BodyVariantConfig } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

export const variantCfg = BODY_VARIANTS.male;
export let root: THREE.Object3D;
export let skinned: THREE.SkinnedMesh;
export let rest: JointAngleRestReference;
export let baselinePose: CustomPose;
export let floorY: number;
export let rootRest0: THREE.Vector3;
export let rootQuat0: THREE.Quaternion;

export type RigVariant = 'male' | 'female';

/** One loaded rig: the variant's GLB posed anatomically, with what sampling
 *  and measuring it needs. */
export interface Rig {
  variant: RigVariant;
  variantCfg: BodyVariantConfig;
  root: THREE.Object3D;
  skinned: THREE.SkinnedMesh;
  rest: JointAngleRestReference;
  baselinePose: CustomPose;
  floorY: number;
  rootRest0: THREE.Vector3;
  rootQuat0: THREE.Quaternion;
}

const rigs = new Map<RigVariant, Promise<Rig>>();

/** Load (once per file) the `variant` rig. */
export function loadRigOf(variant: RigVariant): Promise<Rig> {
  let hit = rigs.get(variant);
  if (!hit) {
    hit = (async () => {
      const cfg = BODY_VARIANTS[variant];
      const url = new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url);
      const buf = readFileSync(fileURLToPath(url));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
        const l = new GLTFLoader();
        l.setMeshoptDecoder(MeshoptDecoder);
        l.parse(ab, '', res as never, rej);
      });
      const scene = gltf.scene;
      scene.scale.setScalar(cfg.pose.rootScale);
      let mesh: THREE.SkinnedMesh | null = null;
      scene.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as THREE.SkinnedMesh;
      });
      scene.updateMatrixWorld(true);
      applyAnatomicPose(scene, cfg);
      scene.updateMatrixWorld(true);
      const m = mesh as unknown as THREE.SkinnedMesh;
      return {
        variant,
        variantCfg: cfg,
        root: scene,
        skinned: m,
        rest: captureJointAngleRestReference(m.skeleton, cfg),
        baselinePose: serializeCustomPose(m.skeleton, cfg, variant),
        floorY: captureFloorReference(m.skeleton, cfg).floorY,
        rootRest0: scene.position.clone(),
        rootQuat0: scene.quaternion.clone(),
      };
    })();
    rigs.set(variant, hit);
  }
  return hit;
}

/** Load the male rig into the bindings above — call it in each file's beforeAll. */
export async function loadRig(): Promise<void> {
  const r = await loadRigOf('male');
  ({ root, skinned, rest, baselinePose, floorY, rootRest0, rootQuat0 } = r);
}

export interface Sampled {
  resolved: ResolvedComposedMotion;
  rec: MotionRecording;
  /** The contacts on the trajectory clock the frames run on. */
  contacts: { foot: string; fromMs: number; toMs: number }[];
}

const cache = new Map<string, Sampled>();
export function sample(motion: () => ComposedMotion, key: string, sampleHz: number): Sampled {
  return sampleOn({ variant: 'male', variantCfg, root, skinned, rest, baselinePose, floorY, rootRest0, rootQuat0 }, motion, key, sampleHz);
}

/** Sample `motion` on `rig` at `sampleHz` (cached by rig, key and rate). */
export function sampleOn(rig: Rig, motion: () => ComposedMotion, key: string, sampleHz: number): Sampled {
  const id = `${rig.variant}:${key}@${sampleHz}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const { root, skinned, variantCfg, rest, baselinePose, rootRest0, rootQuat0 } = rig;
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(motion(), variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz,
  });
  const scale = authoredToTrajectoryTimeScale(resolved, rec.frames[rec.frames.length - 1]!.tMs);
  const contacts = (resolved.contacts ?? []).map((c) => ({
    foot: c.foot,
    fromMs: (c.fromMs ?? -Infinity) * scale,
    toMs: (c.toMs ?? Infinity) * scale,
  }));
  const out = { resolved, rec, contacts };
  cache.set(id, out);
  return out;
}

export const withoutContacts = (motion: () => ComposedMotion) => () => ({ ...motion(), contacts: [] });
export const firstFrameAfter = (rec: MotionRecording, ms: number) => rec.frames.findIndex((f) => f.tMs > ms + 1e-6);
export const firstFrameFrom = (rec: MotionRecording, ms: number) => rec.frames.findIndex((f) => f.tMs >= ms - 1e-6);

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
/** How far (°) joint `key` turns from frame i − 1 to frame i. */
export function jointTurn(rec: MotionRecording, i: number, key: string): number {
  const a = rec.frames[i - 1]!.pose.bones[key]!;
  const b = rec.frames[i]!.pose.bones[key]!;
  return (_qa.set(a[0], a[1], a[2], a[3]).angleTo(_qb.set(b[0], b[1], b[2], b[3])) * 180) / Math.PI;
}

export interface ReleaseSpeeds {
  foot: string;
  toMs: number;
  /** How long the release lasted (ms): to the first frame FK owns the leg. */
  lastedMs: number;
  /** Per chain joint: the release's fastest turn, FK's local peak (from one
   *  base release before the window's end to one after the release's end) and
   *  the hold's own speed on its last frame, all °/frame. */
  joints: { key: string; release: number; fk: number; hold: number }[];
  /** Fastest effector step during the release, and FK's over the same frames (m/frame). */
  effector: number;
  effectorFk: number;
  /** How far the effector drops below the point it was held at during the
   *  release, and how far FK's does over the same frames (m; negative = it
   *  stays above). */
  dip: number;
  dipFk: number;
  /** The effector's fastest change of step (m/frame²): the largest second
   *  difference of its position from the first released frame to the one
   *  after FK takes the leg back. */
  accel: number;
  /** Its clearance over {@link FLOOR_SPAN_MS} after the window's end (or to
   *  the leg's next contact): how far it drops below the held point (m), its
   *  lowest height over the floor (m) and the frames it spends more than
   *  3 mm under it. Absent without a floor height. */
  floor?: { dip: number; low: number; under: number };
}

/** The base release the measurements read around (ms): FK's local peak is
 *  taken from this long before the window's end to this long after the
 *  release's, and a contact of the same leg starting within it (+50 ms) of
 *  the window's end is a hand-over, not a release into swing. Fixed rather
 *  than read off footContact, so an engine with another base (5c1c9ac: 100)
 *  is measured alike. */
const READ_MS = 120;

/** How long after a window's end (ms) the effector's floor clearance is read:
 *  past the longest braking-step release (276 ms), so two engines whose
 *  releases end apart are read over the same span. */
export const FLOOR_SPAN_MS = 300;

/**
 * Measure every release of `contacts` that lets a leg go into swing (not a
 * terminal window, not a hand-over to the same leg's next contact) against
 * the same motion with no contacts. The release ends at the first frame from
 * which the leg's joints are FK's own through to its next contact.
 */
export function releaseSpeeds(s: Sampled, fk: MotionRecording, floorY?: number): ReleaseSpeeds[] {
  const { rec, contacts } = s;
  const T = READ_MS;
  const totalMs = rec.frames[rec.frames.length - 1]!.tMs;
  const out: ReleaseSpeeds[] = [];
  for (const c of contacts) {
    if (!(c.toMs < totalMs - T)) continue;
    const side = c.foot.slice(0, 2);
    if (contacts.some((o) => o !== c && o.foot.startsWith(side) && o.fromMs <= c.toMs + T + 50 && o.toMs > c.toMs)) {
      continue;
    }
    const chain = [`${side}UpLeg`, `${side}Leg`, `${side}Foot`];
    const next = Math.min(
      totalMs + 1,
      ...contacts.filter((o) => o.foot.startsWith(side) && o.fromMs > c.toMs).map((o) => o.fromMs),
    );
    // FK owns the leg where its measured flexions are FK's (the recorded pose
    // of a frame a plant touched is re-read off the skeleton; FK's is the
    // trajectory's own, so compare what both measure).
    const owned = (i: number) =>
      (
        [
          ['UpLeg', 'hipFlexion'],
          ['Leg', 'kneeFlexion'],
          ['Foot', 'ankleFlexion'],
        ] as const
      ).every(([bone, m]) => {
        const a = rec.frames[i]!.angles[`${side}${bone}`]?.[m] ?? 0;
        const b = fk.frames[i]!.angles[`${side}${bone}`]?.[m] ?? 0;
        return Math.abs(a - b) < 1e-6;
      });
    const i0 = firstFrameAfter(rec, c.toMs);
    let ie = -1;
    for (let i = i0; i < rec.frames.length && rec.frames[i]!.tMs < next - 1e-6; i += 1) {
      if (!owned(i)) continue;
      let j = i;
      while (j < rec.frames.length && rec.frames[j]!.tMs < next - 1e-6 && owned(j)) j += 1;
      if (j >= rec.frames.length || rec.frames[j]!.tMs >= next - 1e-6) {
        ie = i;
        break;
      }
    }
    expect(ie, `${c.foot} @${c.toMs.toFixed(0)}: FK takes the leg back`).toBeGreaterThan(i0);
    const lo = Math.max(1, firstFrameFrom(fk, c.toMs - T));
    const hiT = rec.frames[ie]!.tMs + T;
    const joints = chain.map((key) => {
      let release = 0;
      for (let i = i0; i <= ie; i += 1) release = Math.max(release, jointTurn(rec, i, key));
      let peak = 0;
      for (let i = lo; i < fk.frames.length && fk.frames[i]!.tMs <= hiT + 1e-6; i += 1) {
        peak = Math.max(peak, jointTurn(fk, i, key));
      }
      return { key, release, fk: peak, hold: jointTurn(rec, i0 - 1, key) };
    });
    const step = (r: MotionRecording, i: number) => {
      const a = r.frames[i - 1]!.worldTracks![c.foot]!;
      const b = r.frames[i]!.worldTracks![c.foot]!;
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    };
    let effector = 0;
    let effectorFk = 0;
    let low = Infinity;
    let lowFk = Infinity;
    for (let i = i0; i <= ie; i += 1) {
      effector = Math.max(effector, step(rec, i));
      effectorFk = Math.max(effectorFk, step(fk, i));
      low = Math.min(low, rec.frames[i]!.worldTracks![c.foot]![1]);
      lowFk = Math.min(lowFk, fk.frames[i]!.worldTracks![c.foot]![1]);
    }
    const heldY = rec.frames[i0 - 1]!.worldTracks![c.foot]![1];
    const at = (i: number) => rec.frames[i]!.worldTracks![c.foot]!;
    let accel = 0;
    for (let i = Math.max(2, i0); i <= Math.min(rec.frames.length - 1, ie + 1); i += 1) {
      const [a, b, d] = [at(i - 2), at(i - 1), at(i)];
      accel = Math.max(accel, Math.hypot(d[0] - 2 * b[0] + a[0], d[1] - 2 * b[1] + a[1], d[2] - 2 * b[2] + a[2]));
    }
    let floor: ReleaseSpeeds['floor'];
    if (floorY !== undefined) {
      let lowest = Infinity;
      let under = 0;
      for (let i = i0; i < rec.frames.length; i += 1) {
        const t = rec.frames[i]!.tMs;
        if (t > c.toMs + FLOOR_SPAN_MS + 1e-6 || t >= next - 1e-6) break;
        const y = at(i)[1];
        lowest = Math.min(lowest, y);
        if (y < floorY - 0.003) under += 1;
      }
      floor = { dip: heldY - lowest, low: lowest - floorY, under };
    }
    out.push({
      foot: c.foot,
      toMs: c.toMs,
      lastedMs: rec.frames[ie]!.tMs - c.toMs,
      joints,
      effector,
      effectorFk,
      dip: heldY - low,
      dipFk: heldY - lowFk,
      accel,
      ...(floor ? { floor } : {}),
    });
  }
  return out;
}

export const describeRelease = (r: ReleaseSpeeds) =>
  `${r.foot} @${r.toMs.toFixed(0)} ms (${r.lastedMs.toFixed(0)} ms): ` +
  r.joints
    .map((j) => `${j.key} ${j.release.toFixed(2)}°/frame (FK ${j.fk.toFixed(2)}, hold ${j.hold.toFixed(2)})`)
    .join(', ') +
  `; effector ${(r.effector * 1000).toFixed(1)} mm/frame (FK ${(r.effectorFk * 1000).toFixed(1)})` +
  `, dip ${(r.dip * 100).toFixed(2)} cm (FK ${(r.dipFk * 100).toFixed(2)})`;

export type Target = { joint: string; motion: string; targetDegrees: number };
export const target = (joint: string, motion: string, targetDegrees: number): Target => ({ joint, motion, targetDegrees });
export const leg = (side: string, hip: number, knee: number): Target[] => [
  target(`${side}_UpLeg`, 'hipFlexion', hip),
  target(`${side}_Leg`, 'kneeFlexion', knee),
  target(`${side}_Foot`, 'ankleFlexion', 0),
];

/**
 * The single-leg stance as simMOVE's verifier replicates it: shift the weight
 * 9 cm (`shiftM`) onto the left foot over 3 s, then lift the right leg to hip
 * 90° / knee 90° over 3 s and hold. The right foot is held where it stood until
 * the lift starts (3800 ms) — by then FK, riding the shifted pelvis, has it
 * that far away.
 */
export function singleLegStance(shiftM = 0.09): ComposedMotion {
  const standing = [...leg('R', 0, 0), ...leg('L', 0, 0)];
  const lifted = [...leg('R', 90, 90), ...leg('L', 0, 0), target('R_UpLeg', 'hipAbduction', -5)];
  const shifted = { translateM: [shiftM, 0, -0.04] as [number, number, number] };
  return {
    name: 'single-leg stance (replica)',
    startFrom: 'neutral',
    stance: 'planted',
    keyframes: [
      { durationMs: 800, stance: 'planted', targets: standing, root: { translateM: [0, 0, 0] } },
      { durationMs: 3000, stance: 'planted', targets: standing, root: shifted },
      { durationMs: 3000, stance: 'planted', targets: lifted, root: shifted, holdMs: 2000 },
    ],
    contacts: [{ foot: 'L_Foot' }, { foot: 'R_Foot', toMs: 3800 }],
  } as ComposedMotion;
}

/**
 * DDx's walk pattern on the engine's own walk (toeContact.test.ts has the
 * original): each stance held flat from landing to heel rise (35% before the
 * end of terminal stance's keyframe), then by its forefoot until the toes lift
 * 46% into the keyframe after toe-off. The builder's closing contacts are kept.
 */
export function toePivotWalk(speed?: number): ComposedMotion {
  const walk = buildTravelWalk(speed ? { speed } : {});
  const kfs = walk.keyframes;
  const ends: number[] = [];
  kfs.reduce((t, k) => {
    ends.push(t + k.durationMs + (k.holdMs ?? 0));
    return ends[ends.length - 1]!;
  }, 0);
  const rise = (k: number) => ends[k]! - 0.35 * kfs[k]!.durationMs;
  const lift = (k: number) => ends[k - 1]! + 0.46 * kfs[k]!.durationMs;
  return {
    ...walk,
    contacts: [
      { foot: 'R_Foot', fromMs: 0, toMs: rise(4) },
      { foot: 'R_Toes', fromMs: rise(4), toMs: lift(6) },
      { foot: 'L_Foot', fromMs: ends[4]!, toMs: rise(8) },
      { foot: 'L_Toes', fromMs: rise(8), toMs: lift(9) },
      ...(walk.contacts ?? []).slice(2),
    ],
  };
}
