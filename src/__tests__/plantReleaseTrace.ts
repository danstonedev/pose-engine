/**
 * ONE RELEASE, TWO ENGINES, ONE WINDOW — the measurement the release tests
 * compare this tree with 5c1c9ac by (plantReleaseMain*.test.ts), and that
 * 5c1c9ac's own numbers (fixtures/plantRelease.5c1c9ac.json) were measured by:
 * this file, run on a checkout of 5c1c9ac (it uses nothing that tree lacks).
 *
 * A release into swing is a contact window that is not the motion's last and
 * is not handed straight to the same leg's next contact (one starting within
 * 170 ms). Its frames run from the first frame after the window's end to the
 * leg's next contact, or 800 ms (the longest release), whichever is sooner. It
 * ENDS at the first of those frames from which the leg (hip, knee, ankle and
 * toe bones) is its own FK's — the same motion sampled with no contacts, on the
 * same clock — through to the last of them.
 *
 * Two engines' releases end at different times; each is compared with the
 * other over the SAME frames, from the window's end to the later of the two
 * ends: a release that ends sooner is FK's from there, and FK is part of what
 * it is compared on. Per frame, for the leg's hip, knee and ankle:
 *  - speed: how far the joint turns (°/frame);
 *  - speed change: how far its rotation vector moves from the frame before's
 *    (°/frame², the second difference);
 * the released effector's second difference (mm/frame²); and the same speeds
 * of the engine's own FK. Over the 300 ms after the window (to the next
 * contact, if sooner): how far the toes and the ankle go under the floor (cm)
 * and on how many frames more than 3 mm.
 *
 * What is stored for 5c1c9ac is each series' running maximum from the
 * window's end, as its change points — enough to read its peak over any
 * common window.
 */
import { expect } from 'vitest';
import * as THREE from 'three';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { authoredToTrajectoryTimeScale, sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { sampleMotionChain } from '../services/movementChain';
import type { Rig } from './plantReleaseRig';

/** A motion sampled on its own, or one segment of a chain played as a chain
 *  (each segment after the first a continuation, sampleMotionChain). */
export type ReleaseCase = { motion: () => ComposedMotion } | { chain: () => ComposedMotion[]; part: number };

/** No release lasts longer than this (ms) — footContact's cap. */
export const RELEASE_WINDOW_MS = 800;
/** A contact of the same leg starting this soon (ms) after a window's end
 *  takes the leg over: a hand-over, not a release into swing. */
const HAND_OVER_MS = 170;
/** How long after a window's end (ms) the floor is read. */
export const FLOOR_SPAN_MS = 300;
/** How far (m) under the floor a frame counts as under it. */
const UNDER_M = 0.003;
/** The leg is FK's where its measured hip, knee and ankle flexion are FK's
 *  (a frame a plant touched is re-read off the skeleton, so the readouts, not
 *  the stored rotations, are what both recordings share). A chained segment's
 *  FK is sampled apart from the chain from the seed the chain gave it, which
 *  leaves its readouts up to ~0.2° off the chain's where no plant acts, so a
 *  chained segment is read to 0.3°. */
const OWNED_DEG = 1e-6;
const OWNED_CHAIN_DEG = 0.3;
const FLEXIONS = [
  ['UpLeg', 'hipFlexion'],
  ['Leg', 'kneeFlexion'],
  ['Foot', 'ankleFlexion'],
] as const;

const JOINTS = ['UpLeg', 'Leg', 'Foot'] as const;
export const JOINT_NAMES = ['hip', 'knee', 'ankle'] as const;

interface Sampled {
  rec: MotionRecording;
  fk: MotionRecording;
  contacts: { foot: string; fromMs: number; toMs: number }[];
  floorY: number;
  chained: boolean;
}

const cache = new Map<string, Sampled>();

function flattenAngles(angles: Record<string, Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [j, set] of Object.entries(angles)) {
    for (const [m, v] of Object.entries(set)) if (typeof v === 'number' && Number.isFinite(v)) out[`${j}.${m}`] = v;
  }
  return out;
}

function reset(rig: Rig): void {
  rig.root.position.copy(rig.rootRest0);
  rig.root.quaternion.copy(rig.rootQuat0);
  rig.root.updateMatrixWorld(true);
}

const contactsOf = (resolved: ReturnType<typeof resolveComposedMotion>, rec: MotionRecording) => {
  const scale = authoredToTrajectoryTimeScale(resolved, rec.frames[rec.frames.length - 1]!.tMs);
  return (resolved.contacts ?? []).map((c) => ({
    foot: c.foot,
    fromMs: (c.fromMs ?? -Infinity) * scale,
    toMs: (c.toMs ?? Infinity) * scale,
  }));
};

/** Sample `rc` on `rig` at `hz` with its contacts and without (cached by key). */
export function sampleCase(rig: Rig, key: string, rc: ReleaseCase, hz: number): Sampled {
  const id = `${rig.variant}:${key}@${hz}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const { variantCfg, rest, baselinePose, root, skinned } = rig;
  const opts = { baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: hz };
  let out: Sampled;
  if ('motion' in rc) {
    reset(rig);
    const resolved = resolveComposedMotion(rc.motion(), variantCfg);
    expect(resolved.status).toBe('ok');
    const rec = sampleComposedMotion(resolved, opts);
    reset(rig);
    const fkResolved = resolveComposedMotion({ ...rc.motion(), contacts: [] }, variantCfg);
    const fk = sampleComposedMotion(fkResolved, opts);
    out = { rec, fk, contacts: contactsOf(resolved, rec), floorY: rig.floorY, chained: false };
  } else {
    reset(rig);
    const parts = sampleMotionChain(rc.chain(), opts);
    const k = rc.part;
    expect(parts[k]!.status).toBe('ok');
    const prev = k > 0 ? parts[k - 1]!.recording : null;
    const last = prev?.frames[prev.frames.length - 1];
    const seedRoot = last ? { quat: last.root.orientQuat, translateM: last.root.translateM } : null;
    const seed = last ? { currentAngles: flattenAngles(last.angles), currentRoot: seedRoot! } : undefined;
    // The part as sampleMotionChain played it — and FK: that part with no
    // contacts, from the same seed the chain gave it.
    const motion = parts[k]!.motion;
    const resolved = resolveComposedMotion(motion, variantCfg, seed);
    const rec = parts[k]!.recording;
    reset(rig);
    const fkResolved = resolveComposedMotion({ ...motion, contacts: [] }, variantCfg, seed);
    const fk = sampleComposedMotion(fkResolved, {
      ...opts,
      ...(last ? { currentPose: last.pose, currentRoot: seedRoot, name: motion.name } : {}),
    });
    out = { rec, fk, contacts: contactsOf(resolved, rec), floorY: rig.floorY, chained: true };
  }
  expect(out.fk.frames.length, `${id}: FK on the same clock`).toBe(out.rec.frames.length);
  cache.set(id, out);
  return out;
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
/** The rotation vector (°) that takes local rotation `a` to `b` (a⁻¹b). */
function rotvec(a: readonly number[], b: readonly number[]): [number, number, number] {
  _qa.set(a[0]!, a[1]!, a[2]!, a[3]!).invert();
  _qc.copy(_qa).multiply(_qb.set(b[0]!, b[1]!, b[2]!, b[3]!));
  if (_qc.w < 0) _qc.set(-_qc.x, -_qc.y, -_qc.z, -_qc.w);
  const s = Math.hypot(_qc.x, _qc.y, _qc.z);
  if (s < 1e-12) return [0, 0, 0];
  const k = ((2 * Math.atan2(s, _qc.w)) * 180) / Math.PI / s;
  return [_qc.x * k, _qc.y * k, _qc.z * k];
}

/** One release, per frame from the first frame after the window's end. */
export interface ReleaseTrace {
  foot: string;
  toMs: number;
  /** ms after the window's end at which the release ended (the first frame
   *  FK owns the leg from; the window's own end when it never does). */
  endMs: number;
  /** Each frame's time after the window's end (ms). */
  t: number[];
  /** Per joint (hip, knee, ankle): speed (°/frame) and speed change
   *  (°/frame²) into each frame, and FK's speed. */
  speed: number[][];
  change: number[][];
  fkSpeed: number[][];
  /** The effector's second difference into each frame (mm/frame²). */
  accel: number[];
  /** Over FLOOR_SPAN_MS after the window: cm under the floor at the lowest
   *  (0 when never under) and frames more than 3 mm under, toes and ankle. */
  floor: { toesLow: number; toesUnder: number; footLow: number; footUnder: number };
}

/** Every release into swing of `rc` on `rig` at `hz`, keyed `Foot@toMs`. */
export function releaseTraces(rig: Rig, key: string, rc: ReleaseCase, hz: number): Record<string, ReleaseTrace> {
  const { rec, fk, contacts, floorY, chained } = sampleCase(rig, key, rc, hz);
  const F = rec.frames;
  const K = fk.frames;
  const total = F[F.length - 1]!.tMs;
  const out: Record<string, ReleaseTrace> = {};
  for (const c of contacts) {
    if (!(c.toMs < total - 50)) continue;
    const side = c.foot.slice(0, 2);
    const handOver = contacts.some(
      (o) => o !== c && o.foot.startsWith(side) && o.fromMs <= c.toMs + HAND_OVER_MS && o.toMs > c.toMs,
    );
    if (handOver) continue;
    const next = Math.min(total + 1, ...contacts.filter((o) => o.foot.startsWith(side) && o.fromMs > c.toMs).map((o) => o.fromMs));
    const limit = Math.min(next, c.toMs + RELEASE_WINDOW_MS);
    const i0 = F.findIndex((f) => f.tMs > c.toMs + 1e-6);
    let iLast = i0;
    while (iLast + 1 < F.length && F[iLast + 1]!.tMs < limit - 1e-6) iLast += 1;
    const tol = chained ? OWNED_CHAIN_DEG : OWNED_DEG;
    const owned = (i: number) =>
      FLEXIONS.every(([bone, m]) => {
        const a = F[i]!.angles[`${side}${bone}`]?.[m] ?? 0;
        const b = K[i]!.angles[`${side}${bone}`]?.[m] ?? 0;
        return Math.abs(a - b) < tol;
      });
    let end = iLast + 1;
    while (end - 1 >= i0 && owned(end - 1)) end -= 1;
    const endMs = (end <= iLast ? F[end]!.tMs : limit) - c.toMs;
    const t: number[] = [];
    const speed: number[][] = JOINTS.map(() => []);
    const change: number[][] = JOINTS.map(() => []);
    const fkSpeed: number[][] = JOINTS.map(() => []);
    const accel: number[] = [];
    // One frame past the last, for the second differences into it.
    const iStop = Math.min(F.length - 1, iLast + 1);
    for (let i = i0; i <= iStop; i += 1) {
      t.push(F[i]!.tMs - c.toMs);
      JOINTS.forEach((j, n) => {
        const b = `${side}${j}`;
        const v = rotvec(F[i - 1]!.pose.bones[b]!, F[i]!.pose.bones[b]!);
        const u = rotvec(F[Math.max(0, i - 2)]!.pose.bones[b]!, F[i - 1]!.pose.bones[b]!);
        speed[n]!.push(Math.hypot(...v));
        change[n]!.push(Math.hypot(v[0] - u[0], v[1] - u[1], v[2] - u[2]));
        fkSpeed[n]!.push(Math.hypot(...rotvec(K[i - 1]!.pose.bones[b]!, K[i]!.pose.bones[b]!)));
      });
      const p = (k: number) => F[k]!.worldTracks![c.foot]!;
      const [a, b2, d] = [p(Math.max(0, i - 2)), p(i - 1), p(i)];
      accel.push(1000 * Math.hypot(d[0]! - 2 * b2[0]! + a[0]!, d[1]! - 2 * b2[1]! + a[1]!, d[2]! - 2 * b2[2]! + a[2]!));
    }
    const floorOf = (bone: string) => {
      let low = 0;
      let under = 0;
      for (let i = i0; i < F.length && F[i]!.tMs <= c.toMs + FLOOR_SPAN_MS + 1e-6 && F[i]!.tMs < next - 1e-6; i += 1) {
        const y = F[i]!.worldTracks![bone]![1]! - floorY;
        low = Math.max(low, -y * 100);
        if (y < -UNDER_M) under += 1;
      }
      return { low, under };
    };
    const toes = floorOf(`${side}Toes`);
    const foot = floorOf(`${side}Foot`);
    out[`${c.foot}@${c.toMs.toFixed(0)}`] = {
      foot: c.foot,
      toMs: c.toMs,
      endMs,
      t,
      speed,
      change,
      fkSpeed,
      accel,
      floor: { toesLow: toes.low, toesUnder: toes.under, footLow: foot.low, footUnder: foot.under },
    };
  }
  return out;
}

/** A series' running maximum from the window's end, as change points
 *  `[t0, v0, t1, v1, …]` (ms after the window's end, value): the peak over
 *  any window [0, T] is the value of the last point at or before T. */
export type RunningMax = number[];

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function runningMax(t: readonly number[], v: readonly number[]): RunningMax {
  const out: number[] = [];
  let peak = -Infinity;
  for (let i = 0; i < t.length; i += 1) {
    if (v[i]! > peak + 5e-4) {
      peak = v[i]!;
      out.push(r3(t[i]!), r3(peak));
    }
  }
  return out;
}

/** The peak of a stored running maximum over [0, T] (ms after the window). */
export function peakTo(rm: RunningMax, T: number): number {
  let v = 0;
  for (let k = 0; k + 1 < rm.length; k += 2) {
    if (rm[k]! <= T + 1e-6) v = rm[k + 1]!;
    else break;
  }
  return v;
}

/** One engine's release as the fixture keeps it. */
export interface StoredRelease {
  endMs: number;
  speed: RunningMax[];
  change: RunningMax[];
  fkSpeed: RunningMax[];
  accel: RunningMax;
  floor: ReleaseTrace['floor'];
}

export function storeRelease(r: ReleaseTrace): StoredRelease {
  return {
    endMs: r3(r.endMs),
    speed: r.speed.map((s) => runningMax(r.t, s)),
    change: r.change.map((s) => runningMax(r.t, s)),
    fkSpeed: r.fkSpeed.map((s) => runningMax(r.t, s)),
    accel: runningMax(r.t, r.accel),
    floor: {
      toesLow: r3(r.floor.toesLow),
      toesUnder: r.floor.toesUnder,
      footLow: r3(r.floor.footLow),
      footUnder: r.floor.footUnder,
    },
  };
}

/** The peak of a trace's series over [0, T] ms (the frames at or before T,
 *  and one frame past T for a second difference). */
function tracePeak(r: ReleaseTrace, series: readonly number[], T: number, plusOne: boolean): number {
  let v = 0;
  for (let i = 0; i < r.t.length; i += 1) {
    if (r.t[i]! <= T + 1e-6) v = Math.max(v, series[i]!);
    else {
      if (plusOne) v = Math.max(v, series[i]!);
      break;
    }
  }
  return v;
}

/** What one release is compared on: ours and 5c1c9ac's, over the common window. */
export interface ReleaseComparison {
  /** The common window's end (ms after the window). */
  T: number;
  speed: { ours: number; main: number; fkOurs: number; fkMain: number }[];
  change: { ours: number; main: number }[];
  accel: { ours: number; main: number };
  floor: { ours: ReleaseTrace['floor']; main: ReleaseTrace['floor'] };
}

export function compareRelease(ours: ReleaseTrace, main: StoredRelease): ReleaseComparison {
  const T = Math.max(ours.endMs, main.endMs);
  // A second difference into the frame after the window's last is still the
  // release's: the frame it ends on turns into FK's there.
  const Tc = T;
  return {
    T,
    speed: JOINT_NAMES.map((_, n) => ({
      ours: tracePeak(ours, ours.speed[n]!, T, false),
      main: peakTo(main.speed[n]!, T),
      fkOurs: tracePeak(ours, ours.fkSpeed[n]!, T, false),
      fkMain: peakTo(main.fkSpeed[n]!, T),
    })),
    change: JOINT_NAMES.map((_, n) => ({
      ours: tracePeak(ours, ours.change[n]!, Tc, true),
      main: peakTo(main.change[n]!, nextTime(ours, Tc)),
    })),
    accel: { ours: tracePeak(ours, ours.accel, Tc, true), main: peakTo(main.accel, nextTime(ours, Tc)) },
    floor: { ours: ours.floor, main: main.floor },
  };
}

/** The time of the first of our frames after T (the same frame times as
 *  5c1c9ac's on the same clock), or T. */
function nextTime(ours: ReleaseTrace, T: number): number {
  const i = ours.t.findIndex((t) => t > T + 1e-6);
  return i < 0 ? T : ours.t[i]!;
}
