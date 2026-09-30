import * as THREE from 'three';
import type { CustomPose } from '../types';
import { segmentDistance, type Vec3 } from './limbClearance';
import type { PoseTrajectory } from './motionTrajectory';
import { ballJointAngles } from './jointAngles';
import { getEffectiveRomRange, type RomScenarioConstraints } from './romConstraints';

type Q = [number, number, number, number];
interface LegFrame { hip: Vec3; knee: Vec3; ankle: Vec3; hipWorld: Q; hipLocal: Q; kneeWorld: Q; kneeLocal: Q }
export type GaitLegFrames = Record<'L' | 'R', LegFrame>;
export interface GaitClearancePlan {
  frames: GaitLegFrames;
  windows: { foot: string; fromMs: number; toMs: number }[];
  durationsMs: number[];
  holdsMs: number[];
  constraints?: RomScenarioConstraints | null;
}
const quat = (q: Q) => new THREE.Quaternion().fromArray(q);
const vec = (p: Vec3) => new THREE.Vector3().fromArray(p);

/** Immutable geometry in the body's anatomic frame. Root travel and pelvic
 * rotation cannot change inter-leg distances, so neither enters this solve.
 */
export function captureGaitLegFrames(bones: ReadonlyMap<string, THREE.Bone>): GaitLegFrames | undefined {
  const result = {} as GaitLegFrames;
  for (const side of ['L', 'R'] as const) {
    const hip = bones.get(`${side}_UpLeg`), knee = bones.get(`${side}_Leg`), ankle = bones.get(`${side}_Foot`);
    if (!hip || !knee || !ankle) return undefined;
    result[side] = {
      hip: hip.getWorldPosition(new THREE.Vector3()).toArray(),
      knee: knee.getWorldPosition(new THREE.Vector3()).toArray(),
      ankle: ankle.getWorldPosition(new THREE.Vector3()).toArray(),
      hipWorld: hip.getWorldQuaternion(new THREE.Quaternion()).toArray(), hipLocal: hip.quaternion.toArray(),
      kneeWorld: knee.getWorldQuaternion(new THREE.Quaternion()).toArray(), kneeLocal: knee.quaternion.toArray(),
    };
  }
  return result;
}

/** FK including the rig's actual hinge frames and segment lengths. */
export function gaitLegPoints(pose: CustomPose, frames: GaitLegFrames, side: 'L' | 'R'): [Vec3, Vec3, Vec3] {
  const r = frames[side];
  const hipDelta = quat(r.hipWorld).multiply(quat(r.hipLocal).invert())
    .multiply(quat(pose.bones[`${side}_UpLeg`] ?? r.hipLocal)).multiply(quat(r.hipWorld).invert());
  const kneeDelta = hipDelta.clone().multiply(quat(r.kneeWorld)).multiply(quat(r.kneeLocal).invert())
    .multiply(quat(pose.bones[`${side}_Leg`] ?? r.kneeLocal)).multiply(quat(r.kneeWorld).invert());
  const knee = vec(r.knee).sub(vec(r.hip)).applyQuaternion(hipDelta).add(vec(r.hip));
  const ankle = vec(r.ankle).sub(vec(r.knee)).applyQuaternion(kneeDelta).add(knee);
  return [r.hip, knee.toArray(), ankle.toArray()];
}

/** Distal thigh and shank envelopes. The proximal thigh attachment is excluded:
 * opposite gluteal attachments share the pelvis and are not a collision pair.
 * This is an engineering clearance envelope, not a soft-tissue contact solver.
 */
export function gaitLegClearance(pose: CustomPose, frames: GaitLegFrames): number {
  const l = gaitLegPoints(pose, frames, 'L'), r = gaitLegPoints(pose, frames, 'R');
  const scale = (vec(frames.L.hip).distanceTo(vec(frames.L.knee)) + vec(frames.R.hip).distanceTo(vec(frames.R.knee))) / .94;
  const segments = (p: [Vec3, Vec3, Vec3]) => {
    const at = (a: number, b: number, u: number): Vec3 => vec(p[a]!).lerp(vec(p[b]!), u).toArray();
    return [
      { a: at(0, 1, .35), b: at(0, 1, .7), radius: .089 },
      { a: at(0, 1, .7), b: p[1], radius: .062 },
      { a: p[1], b: at(1, 2, .65), radius: .07 },
      { a: at(1, 2, .65), b: p[2], radius: .045 },
    ];
  };
  let clearance = Infinity;
  for (const a of segments(l)) for (const b of segments(r))
    clearance = Math.min(clearance, segmentDistance(a.a, a.b, b.a, b.b) - (a.radius + b.radius) * scale);
  return clearance;
}

/** Minimal outward correction of the swinging hip, preserving the stance pose
 * and authored knee/ankle motion. The shared trajectory supplies this pose to
 * travel derivation, playback and recording, before foot plants are solved.
 */
export function constrainGaitLegPose(pose: CustomPose, frames: GaitLegFrames, swing: 'L' | 'R', constraints?: RomScenarioConstraints | null): CustomPose {
  if (gaitLegClearance(pose, frames) >= 0) return pose;
  const key = `${swing}_UpLeg`, r = frames[swing], original = pose.bones[key];
  if (!original) return pose;
  const parent = quat(r.hipWorld).multiply(quat(r.hipLocal).invert());
  const axis = new THREE.Vector3(0, 0, swing === 'L' ? 1 : -1).applyQuaternion(parent.clone().invert());
  const at = (degrees: number): CustomPose => ({ ...pose, bones: { ...pose.bones,
    [key]: new THREE.Quaternion().setFromAxisAngle(axis, degrees * Math.PI / 180).multiply(quat(original)).toArray(),
  } });
  const valid = (candidate: CustomPose) => {
    // Match the clinical readout: current * rest^-1, in the parent frame.
    const a = ballJointAngles(quat(candidate.bones[key]!).multiply(quat(r.hipLocal).invert()), new THREE.Vector3(0, -1, 0), swing === 'R');
    const thigh = { flexionDeg: -a.flexion, abductionDeg: a.abduction };
    return [['hipFlexion', -a.flexion], ['hipAbduction', a.abduction], ['hipRotation', a.rotation]].every(([field, value]) => {
      const range = getEffectiveRomRange(constraints, key, field as string, thigh);
      return !range || (value as number) >= range.min - .01 && (value as number) <= range.max + .01;
    });
  };
  let low = 0, high = 0;
  let candidate = pose;
  // Bounded, deterministic search. Never move the loaded limb to obtain a pass.
  for (high = 2; high <= 30; high += 2) {
    candidate = at(high);
    if (!valid(candidate)) {
      // Joint capacity wins if the requested path cannot be cleared within it.
      // Do not manufacture extra patient ROM to make the envelope pass.
      let upper = high;
      for (let i = 0; i < 7; i++) {
        const mid = (low + upper) / 2;
        if (valid(at(mid))) low = mid;
        else upper = mid;
      }
      return low > 0 ? at(low) : pose;
    }
    if (gaitLegClearance(candidate, frames) >= 0) break;
    low = high;
  }
  if (high > 30) return candidate;
  for (let i = 0; i < 7; i++) {
    const mid = (low + high) / 2;
    candidate = at(mid);
    if (gaitLegClearance(candidate, frames) >= 0) high = mid;
    else low = mid;
  }
  return at(high);
}

export function withGaitLegClearance(trajectory: PoseTrajectory, plan: GaitClearancePlan | undefined, timeScale: number, phaseOffsetMs = 0): PoseTrajectory {
  if (!plan) return trajectory;
  const paced = plan.durationsMs.map((d, i) => [d / timeScale, Math.min((plan.holdsMs[i] ?? 0) / timeScale, 10000)]);
  const period = paced.reduce((s, p) => s + p[0]! + p[1]!, 0);
  const authoredAt = (tMs: number) => {
    let remaining = tMs + phaseOffsetMs;
    if (period > 0 && (phaseOffsetMs > 0 || remaining > period)) remaining %= period;
    let authored = 0;
    for (let i = 0; i < paced.length; i++) {
      const [travel, hold] = paced[i]!;
      if (remaining <= travel!) return authored + Math.max(0, remaining) * timeScale;
      authored += plan.durationsMs[i]!;
      remaining -= travel!;
      if (remaining <= hold!) return authored + (hold! > 0 ? remaining / hold! * (plan.holdsMs[i] ?? 0) : 0);
      authored += plan.holdsMs[i] ?? 0;
      remaining -= hold!;
    }
    return authored;
  };
  const constrainGaitPoseAt = (pose: CustomPose, tMs: number) => {
    const t = authoredAt(tMs);
    const stance = plan.windows.find(w => t >= w.fromMs && t < w.toMs)?.foot;
    return stance ? constrainGaitLegPose(pose, plan.frames, stance === 'L_Foot' ? 'R' : 'L', plan.constraints) : pose;
  };
  return { ...trajectory, constrainGaitPoseAt, sampleAt(tMs) {
    const sample = trajectory.sampleAt(tMs);
    return { ...sample, pose: constrainGaitPoseAt(sample.pose, tMs) };
  } };
}
