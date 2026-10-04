import * as THREE from 'three';
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';
import type { JointAngleRestReference } from './jointAngles';
import type { ResolvedComposedMotion, StanceContact } from './motionSequence';
import { getEffectiveRomRange, type RomScenarioConstraints } from './romConstraints';
import { sampleComposedMotion, type RecordedFrame, type SkeletonSampleHarness } from './motionRecording';
import { applyCustomPose } from './poseRig';
import { rotateRestReferenceByRoot, rotateRestReferenceByPelvis } from './rootMotion';
import { motionRigInputKey } from './motionRigInputKey';

/** Geometric planning tolerances; they do not widen a joint or patient limit. */
export const PRESSUP_PALM_LAYOUT_NUMERICS = Object.freeze({
  targetElbowFlexionDeg: 10, endpointMaximumFlexionDeg: 12,
  palmDriftM: .0005, maximumIterations: 8, maximumForwardStep: .15,
});

export interface PronePalmLayoutIteration {
  forward: number;
  peakElbowFlexionDeg: [number, number];
  maximumPalmDriftM: number;
  bodySupportFeasible: boolean;
  endpointReached: boolean;
  fixedWristPointsM: { L: [number, number, number]; R: [number, number, number] };
  supportForward: [number, number, number];
  geometry: { side: 'L' | 'R'; upperLengthM: number; forearmLengthM: number; radialSquaredM2: number; forwardCorrection: number | null }[];
}

export interface PronePalmLayoutResult {
  contacts: StanceContact[];
  forward: number | null;
  endpointReached: boolean;
  bodySupportFeasible: boolean;
  maximumPalmDriftM: number | null;
  selectedIteration: number | null;
  iterations: PronePalmLayoutIteration[];
  bodySupportFailures: { tMs: number; reasons: string[]; activeLimits: string[]; gapM: Record<string, number> }[];
  reasons: string[];
  scope: string;
}

export interface PreparePressupPalmLayoutOptions {
  resolvedMotion: ResolvedComposedMotion;
  baselinePose: CustomPose;
  variantCfg: BodyVariantConfig;
  rest: JointAngleRestReference;
  skeletonHarness: SkeletonSampleHarness;
  constraints?: RomScenarioConstraints | null;
}

// Replaying/importing the same authored motion should not redo its geometric
// search. Cache only within the same rig, against every input the sampler can
// observe. Return copies so editing a contact/result cannot poison a later run.
const layoutCache = new WeakMap<THREE.Object3D, Map<string, PronePalmLayoutResult>>();
/** Plan ONE fixed bilateral palm layout from actual segment/endpoint geometry.
 *
 * Every evaluation uses the production bounded source sampler. The flag is
 * explicitly disabled in each probe, so a sampler that calls this planner does
 * not recurse. Nothing moves the contact targets while the motion is playing.
 * A failed endpoint remains a failed endpoint; an unsafe trial never replaces
 * the original contacts. The entire harness, including helper bones, is restored.
 *
 * This sparse planner does not approve motion: between-sample skin, wrist surface
 * alignment, all joint readouts, native dynamics and host playback still need the
 * existing full checks. Drift is measured against the first realized wrist, not
 * mislabeled as an absolute solver-target residual.
 */
export function preparePressupPalmLayout(options: PreparePressupPalmLayoutOptions): PronePalmLayoutResult {
  const root = options.skeletonHarness.root;
  const key = motionRigInputKey(options);
  const cache = layoutCache.get(root) ?? new Map<string, PronePalmLayoutResult>();
  const cached = cache.get(key);
  if (cached) return structuredClone(cached);
  const result = derivePressupPalmLayout(options);
  cache.set(key, structuredClone(result));
  while (cache.size > 4) cache.delete(cache.keys().next().value!);
  layoutCache.set(root, cache);
  return result;
}

function derivePressupPalmLayout(options: PreparePressupPalmLayoutOptions): PronePalmLayoutResult {
  const { resolvedMotion: motion, skeletonHarness: { root, skinned } } = options;
  const originalContacts = structuredClone(motion.contacts ?? []);
  const result: PronePalmLayoutResult = {
    contacts: originalContacts, forward: null, endpointReached: false,
    bodySupportFeasible: false, maximumPalmDriftM: null, selectedIteration: null,
    iterations: [], bodySupportFailures: [], reasons: [],
    scope: 'Sparse setup, extension, hold and optional return poses; geometry-derived fixed palm layout. Not dense skin, clinical, native or host acceptance.',
  };
  const fail = (reason: string) => { result.reasons.push(reason); return result; };
  const palms = originalContacts.filter(contact => contact.palmSupport && /^(L|R)_Hand$/.test(contact.foot));
  if (!motion.pronePalmAnchorFit || !motion.proneSkinSupport || !motion.startAtSetup || motion.status !== 'ok'
    || motion.loop || motion.reps !== 1 || ![2, 3].includes(motion.keyframes.length)
    || motion.modifiers?.timeScale != null && motion.modifiers.timeScale !== 1
    || !Number.isFinite(motion.supportPlaneY)
    || motion.keyframes.some(frame => frame.stance !== 'planted' || frame.groundingPosture !== 'prone-supported')
    || palms.length !== 2 || new Set(palms.map(contact => contact.foot)).size !== 2
    || palms.some(contact => contact.holdOrientation !== 'palm-down' || contact.palmSupport?.surface !== 'skin')) {
    return fail('unsupported-prepared-pressup-scope');
  }
  if (palms[0].palmSupport!.forward !== palms[1].palmSupport!.forward) return fail('bilateral-forward-layout-must-share-one-geometric-parameter');
  const peak = motion.keyframes[1], setup = motion.keyframes[0];
  if (!peak.targets.some(target => (target.joint === 'Spine_Lower' || target.joint === 'Spine_Upper') && target.motion === 'flexion' && target.clampedDegrees < 0)) {
    return fail('second-keyframe-is-not-an-extension-endpoint');
  }
  // Moving a fixed palm cannot make an excluded elbow angle permissible. Keep
  // the authored contacts and report this before an expensive geometric search;
  // ordinary bounded playback still runs and reports its actual support result.
  for (const side of ['L', 'R'] as const) {
    const range = getEffectiveRomRange(options.constraints ?? motion.constraints, `${side}_Forearm`, 'elbowFlexion');
    if (range && (range.min > PRESSUP_PALM_LAYOUT_NUMERICS.endpointMaximumFlexionDeg || range.max < -.05)) {
      return fail(`patient-elbow-range-excludes-extension-endpoint:${side}_Forearm:${range.min}..${range.max}`);
    }
  }
  const setupTime = setup.durationMs + setup.holdMs;
  const peakTime = setupTime + peak.durationMs;
  const endTime = motion.keyframes.reduce((sum, frame) => sum + frame.durationMs + frame.holdMs, 0);
  // Screen Hold ends at the assessed hold; it has no separate return phase.
  // Keep each probe distinct instead of sampling that endpoint twice.
  const times = [...new Set([0, setupTime, peakTime, peakTime + peak.holdMs, endTime])];
  const transforms = [root, ...skinned.skeleton.bones].map(node => ({
    node, p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone(),
    matrix: node.matrix.clone(), matrixAutoUpdate: node.matrixAutoUpdate,
  }));
  const restore = () => {
    for (const value of transforms) {
      value.node.position.copy(value.p); value.node.quaternion.copy(value.q); value.node.scale.copy(value.s);
      value.node.matrix.copy(value.matrix); value.node.matrixAutoUpdate = value.matrixAutoUpdate;
    }
    root.updateMatrixWorld(true);
    root.traverse(node => { if ((node as THREE.SkinnedMesh).isSkinnedMesh) (node as THREE.SkinnedMesh).skeleton.update(); });
  };
  let forward = palms[0].palmSupport!.forward;
  let bestScore = Infinity;
  try {
    for (let index = 0; index < PRESSUP_PALM_LAYOUT_NUMERICS.maximumIterations; index++) {
      restore();
      const probe = structuredClone(motion);
      probe.pronePalmAnchorFit = false;
      for (const contact of probe.contacts ?? []) if (contact.palmSupport && /^(L|R)_Hand$/.test(contact.foot)) contact.palmSupport.forward = forward;
      const recording = sampleComposedMotion(probe, {
        baselinePose: options.baselinePose, variantCfg: options.variantCfg, rest: options.rest,
        skeletonHarness: options.skeletonHarness, constraints: options.constraints ?? motion.constraints,
        sampleHz: 1, frameTimesMs: times,
        trackedBones: ['L_UpperArm', 'R_UpperArm', 'L_Forearm', 'R_Forearm', 'L_Hand', 'R_Hand'],
      });
      const first = recording.frames[0], endpoint = recording.frames.find(frame => frame.tMs === peakTime)!;
      // Match contact capture's root/pelvis-rebased anatomical forward. A model
      // heading is not necessarily world +Z, and pelvic tilt is also authored.
      root.position.copy(transforms[0].p).add(new THREE.Vector3().fromArray(first.root.translateM));
      root.quaternion.copy(transforms[0].q).multiply(new THREE.Quaternion().fromArray(first.root.orientQuat));
      root.scale.copy(transforms[0].s);
      applyCustomPose(skinned.skeleton, options.variantCfg, first.pose);
      root.updateMatrixWorld(true);
      const activeRest = rotateRestReferenceByPelvis(rotateRestReferenceByRoot(options.rest,
        root.quaternion.clone().multiply(transforms[0].q.clone().invert())), skinned.skeleton, options.variantCfg);
      const direction = activeRest.worldDirs?.Spine_Lower;
      const supportForward = direction ? new THREE.Vector3().fromArray(direction) : new THREE.Vector3(0, 0, 1);
      supportForward.y = 0;
      if (supportForward.lengthSq() < 1e-8) supportForward.set(0, 0, 1);
      supportForward.normalize();
      const supportSide = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), supportForward);
      const position = (frame: RecordedFrame, side: 'L' | 'R', part: string) => {
        const value = frame.worldTracks?.[side + '_' + part];
        if (!value || value.some(component => !Number.isFinite(component))) throw Error('Missing finite palm-planning landmark');
        return new THREE.Vector3().fromArray(value);
      };
      const elbows = (['L', 'R'] as const).map(side => endpoint.angles[side + '_Forearm']?.elbowFlexion) as [number, number];
      if (elbows.some(value => !Number.isFinite(value))) throw Error('Missing finite palm-planning elbow angle');
      const drift = Math.max(...recording.frames.flatMap(frame => (['L', 'R'] as const).map(side => position(frame, side, 'Hand').distanceTo(position(first, side, 'Hand')))));
      const bodySupportFeasible = recording.frames.every(frame => frame.proneSupport?.feasible === true);
      result.bodySupportFailures = recording.frames.filter(frame => frame.proneSupport?.feasible !== true).map(frame => ({
        tMs: frame.tMs, reasons: frame.proneSupport?.reasons ?? ['missing-prone-support-result'],
        activeLimits: frame.proneSupport?.activeLimits ?? [],
        gapM: Object.fromEntries(Object.entries(frame.proneSupport?.regions ?? {}).map(([key, witness]) => [key, witness.gapM])),
      }));
      const endpointReached = elbows.every(value => value >= -.05 && value <= PRESSUP_PALM_LAYOUT_NUMERICS.endpointMaximumFlexionDeg)
        && drift <= PRESSUP_PALM_LAYOUT_NUMERICS.palmDriftM && bodySupportFeasible;
      const geometry = (['L', 'R'] as const).map(side => {
        const shoulder = position(endpoint, side, 'UpperArm'), elbow = position(endpoint, side, 'Forearm'), wrist = position(endpoint, side, 'Hand');
        const upperLengthM = shoulder.distanceTo(elbow), forearmLengthM = elbow.distanceTo(wrist);
        const desiredReachSquared = upperLengthM ** 2 + forearmLengthM ** 2
          + 2 * upperLengthM * forearmLengthM * Math.cos(PRESSUP_PALM_LAYOUT_NUMERICS.targetElbowFlexionDeg * Math.PI / 180);
        const delta = wrist.clone().sub(shoulder);
        const radialSquaredM2 = desiredReachSquared - delta.y ** 2 - delta.dot(supportSide) ** 2;
        const forwardCorrection = radialSquaredM2 >= 0 && upperLengthM > 1e-6 ? (Math.sqrt(radialSquaredM2) - delta.dot(supportForward)) / upperLengthM : null;
        return { side, upperLengthM, forearmLengthM, radialSquaredM2, forwardCorrection };
      });
      result.iterations.push({ forward, peakElbowFlexionDeg: elbows, maximumPalmDriftM: drift, bodySupportFeasible, endpointReached,
        fixedWristPointsM: { L: position(first, 'L', 'Hand').toArray(), R: position(first, 'R', 'Hand').toArray() },
        supportForward: supportForward.toArray(), geometry });
      // Only a body-supported, stable-palm candidate may replace source layout.
      const stable = bodySupportFeasible && drift <= PRESSUP_PALM_LAYOUT_NUMERICS.palmDriftM;
      const score = Math.max(...elbows);
      if (stable && score < bestScore) {
        bestScore = score; result.contacts = structuredClone(probe.contacts ?? []); result.forward = forward;
        result.selectedIteration = index; result.endpointReached = endpointReached;
        result.bodySupportFeasible = bodySupportFeasible; result.maximumPalmDriftM = drift;
      }
      if (endpointReached) break;
      // Lower-body support precedes hand solving. Changing a horizontal palm
      // layout cannot release a hip/knee/thoracic patient bound, so do not repeat
      // this expensive solve eight times with the same unresolved support.
      if (!bodySupportFeasible) { result.reasons.push('body-support-unresolved; anchor refinement cannot change lower-body feasibility'); break; }
      const corrections = geometry.map(value => value.forwardCorrection).filter((value): value is number => value != null);
      if (corrections.length !== 2) { result.reasons.push('endpoint-outside-floor-reach-sphere'); break; }
      const delta = corrections.reduce((sum, value) => sum + value, 0) / 2;
      // Bound iterations, not anatomy. A contact layout that leaves this local
      // geometric search remains explicitly unresolved rather than extrapolated.
      const next = Math.max(-.1, Math.min(1, forward + Math.max(-PRESSUP_PALM_LAYOUT_NUMERICS.maximumForwardStep, Math.min(PRESSUP_PALM_LAYOUT_NUMERICS.maximumForwardStep, delta))));
      if (Math.abs(next - forward) < .00001) { result.reasons.push('anchor-refinement-stalled'); break; }
      forward = next;
    }
    if (result.selectedIteration == null) result.reasons.push('no-body-supported-stable-palm-candidate; original contacts retained');
    if (!result.endpointReached) result.reasons.push('full-extension-endpoint-unresolved');
  } finally {
    restore();
  }
  return result;
}
