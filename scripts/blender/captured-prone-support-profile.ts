// Diagnostic copy; no control flow, caches, geometry or outputs changed.
import * as THREE from 'three';
import type { BodyVariantConfig } from '../../src/anatomy/bodyVariants';
import type { CustomPose } from '../../src/types';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../../src/services/poseRig';
import { computeJointAngles, type JointAngleRestReference } from '../../src/services/jointAngles';
import { buildComposedCommandPose } from '../../src/services/movementCommand';
import { getEffectiveRomRange, type RomScenarioConstraints } from '../../src/services/romConstraints';
import type { PosedSupportSurface } from '../../src/services/rootMotion';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay';
import { clampMeasuredPatientHinge, clampMeasuredPatientHip } from '../../src/services/poseRomClamp';
import { createPosedVertexReader } from '../../src/services/posedGeometry';

/** Numerical convergence, not movement/clinical acceptance. Geometry and ROM
 * remain authoritative; a failed support is reported instead of expanding ROM. */
export const PRONE_SKIN_SUPPORT_NUMERICS = Object.freeze({
  toleranceM: .00005, derivativeStepDeg: .1, maximumStepDeg: 3, maximumIterations: 12,
});

type Side = 'L' | 'R';
const REGION_KEYS = ['pelvis', 'torso', 'head', 'L_leg', 'R_leg', 'L_thighCalf', 'R_thighCalf', 'L_envelope', 'R_envelope', 'L_kneeBand', 'R_kneeBand', 'L_toes', 'R_toes'] as const;
type Region = typeof REGION_KEYS[number];
type Ref = { skin: THREE.SkinnedMesh; vertex: number; bone: string; measuredAt: number; height: number };
export interface ProneSkinWitness { minimumY: number; gapM: number; mesh: string; vertex: number; dominantBone: string }
export interface ProneSkinSupportResult {
  feasible: boolean;
  reusedSolution: boolean;
  iterations: number;
  pelvisMinimumY: number;
  requiredRootTranslationM: number;
  regions: Record<Region, ProneSkinWitness>;
  correctedDegrees: { thoracicFlexion: number; L_hipFlexion: number; R_hipFlexion: number; L_kneeFlexion: number; R_kneeFlexion: number };
  activeLimits: string[];
  reasons: string[];
  scope: string;
}
export interface ProneSkinSupportOptions {
  root: THREE.Object3D;
  skinned: THREE.SkinnedMesh;
  variantCfg: BodyVariantConfig;
  /** Anatomical reference, before authored movement/root reorientation. */
  baselinePose: CustomPose;
  rest: JointAngleRestReference;
  /** Use the host's transient twist overlay when it contributes rendered skin. */
  sampleSkin?: <T>(read: () => T) => T;
}

/** Opt-in geometric support of an authored prone body. The pelvis is the sole
 * vertical reference; the caller performs root grounding AFTER this correction.
 * Leg support uses actual full thigh/calf and toe skin. The historical distal
 * envelope and knee band remain separately measured: a thicker adjacent thigh
 * surface can support a leg before its distal band touches. This does not infer
 * load, friction or compression.
 * No movement is opted in by constructing this helper.
 */
export function createProneSkinSupport(options: ProneSkinSupportOptions) {
  const { root, skinned, variantCfg, baselinePose, rest } = options;
  const bones = buildBoneByPoseKey(skinned.skeleton, variantCfg);
  const required = ['Hips', 'Spine_Mid', 'Spine_Upper', 'L_UpLeg', 'R_UpLeg', 'L_Leg', 'R_Leg', 'L_Foot', 'R_Foot', 'L_Toes', 'R_Toes'];
  for (const key of required) if (!bones.has(key)) throw new Error(`Missing prone support bone ${key}`);
  const ownership = new Map<THREE.Object3D, string>([...bones].map(([key, bone]) => [bone, key]));
  const regions = {} as Record<Region, Ref[]>;
  for (const key of REGION_KEYS) regions[key] = [];
  const skins: THREE.SkinnedMesh[] = [];
  root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) skins.push(object as THREE.SkinnedMesh); });
  const ownedTwist = options.sampleSkin ? null : createStageTwistOverlay();
  const sampleSkin = options.sampleSkin ?? (<T>(read: () => T) => ownedTwist!.sampleWithTwist(read));
  const point = new THREE.Vector3();
  const skinReader = createPosedVertexReader();
  const timed = <T>(key:string, read:()=>T):T => {const row=(globalThis as any).__proneCost; if(!row)return read(); const start=performance.now(); try{return read();}finally{const stats=row[key]??=( {calls:0,ms:0});stats.calls++;stats.ms+=performance.now()-start;}};
  const refreshWorld = () => timed('refreshWorld', () => {
    root.parent?.updateWorldMatrix(true, false);
    // updateWorldMatrix alone skips SkinnedMesh's bindMatrixInverse refresh,
    // which would count a root translation twice when measuring skin.
    root.updateMatrixWorld(true);
  });
  const owner = (bone: THREE.Bone) => {
    let ancestor: THREE.Object3D | null = bone;
    while (ancestor) { const key = ownership.get(ancestor); if (key) return key; ancestor = ancestor.parent; }
    return null;
  };
  // Membership is defined once against the anatomical reference, never by a
  // transient solver iterate or whichever frame the user first scrubs to.
  const saved = skinned.skeleton.bones.map(bone => ({ bone, p: bone.position.clone(), q: bone.quaternion.clone(), s: bone.scale.clone() }));
  try {
    applyCustomPose(skinned.skeleton, variantCfg, baselinePose);
    ownedTwist?.reset(skinned.skeleton, variantCfg);
    refreshWorld();
    sampleSkin(() => {
      refreshWorld();
      skinReader.beginMeasurement();
      const legs = Object.fromEntries((['L', 'R'] as const).map(side => {
        const hip = bones.get(`${side}_UpLeg`)!.getWorldPosition(new THREE.Vector3()), knee = bones.get(`${side}_Leg`)!.getWorldPosition(new THREE.Vector3());
        return [side, { hip, knee, axis: knee.clone().sub(hip).normalize(), length: hip.distanceTo(knee) }];
      })) as Record<Side, { hip: THREE.Vector3; knee: THREE.Vector3; axis: THREE.Vector3; length: number }>;
      for (const skin of skins) {
        const ids = skin.geometry.getAttribute('skinIndex'), weights = skin.geometry.getAttribute('skinWeight');
        if (!ids || !weights) continue;
        for (let vertex = 0; vertex < ids.count; vertex++) {
          let largest = -Infinity, dominant = 0;
          for (let slot = 0; slot < weights.itemSize; slot++) if (weights.getComponent(vertex, slot) > largest) {
            largest = weights.getComponent(vertex, slot); dominant = ids.getComponent(vertex, slot);
          }
          const bone = skin.skeleton.bones[dominant]; if (!bone) continue;
          const key = owner(bone), ref = { skin, vertex, bone: bone.name, measuredAt: -1, height: 0 };
          if (key === 'Hips') regions.pelvis.push(ref);
          if (key?.startsWith('Spine_')) regions.torso.push(ref);
          if (key === 'Head' || key?.startsWith('Neck')) regions.head.push(ref);
          for (const side of ['L', 'R'] as const) {
            if (![`${side}_UpLeg`, `${side}_Leg`, `${side}_Foot`, `${side}_Toes`].includes(key ?? '')) continue;
            regions[`${side}_leg`].push(ref);
            if (key === `${side}_Toes`) regions[`${side}_toes`].push(ref);
            if (key === `${side}_UpLeg` || key === `${side}_Leg`) {
              regions[`${side}_thighCalf`].push(ref);
              skinReader.getVertexPosition(skin, vertex, point).applyMatrix4(skin.matrixWorld);
              const leg = legs[side], along = point.clone().sub(leg.hip).dot(leg.axis);
              if (key === `${side}_Leg` || along >= .5 * leg.length) regions[`${side}_envelope`].push(ref);
              if (Math.abs(along - leg.length) <= .1 * leg.length) regions[`${side}_kneeBand`].push(ref);
            }
          }
        }
      }
    });
  } finally {
    for (const { bone, p, q, s } of saved) { bone.position.copy(p); bone.quaternion.copy(q); bone.scale.copy(s); }
    refreshWorld();
  }
  for (const [key, refs] of Object.entries(regions)) if (!refs.length) throw new Error(`Missing prone support skin: ${key}`);
  const pelvisSurface: PosedSupportSurface = { meshes: skins.map(skin => ({ skin, vertices: regions.pelvis.filter(ref => ref.skin === skin).map(ref => ref.vertex) })).filter(mesh => mesh.vertices.length) };
  const ownedKeys = ['Spine_Mid', 'Spine_Upper', ...(['L', 'R'] as const).flatMap(side => ['UpLeg', 'Leg', 'Foot', 'Toes'].map(part => `${side}_${part}`))];
  const cache = new Map<string, { pose: Map<string, THREE.Quaternion> }>();
  const witnessRefs = new WeakMap<ProneSkinWitness, Ref>();
  let measurementId = 0;
  function measure(selected: readonly Region[] = Object.keys(regions) as Region[]) {return timed(`measure:${selected.join("+")}`,()=>measureInner(selected));}
  function measureInner(selected: readonly Region[] = Object.keys(regions) as Region[]) {
    const epoch = ++measurementId;
    refreshWorld();
    return sampleSkin(() => {
      refreshWorld();
      // CPU getVertexPosition reads the bones' world matrices and inverse bind
      // matrices directly. Rebuilding the GPU bone palette for each numerical
      // probe adds work without affecting these exact skin measurements.
      skinReader.beginMeasurement();
      const measured = {} as Record<Region, ProneSkinWitness>;
      for (const region of new Set<Region>(['pelvis', ...selected])) {
        const refs = regions[region];
        let minimumY = Infinity, witness = refs[0]!;
        for (const ref of refs) {
          // The complete leg, distal envelope, knee band and toes overlap.
          // Reuse a vertex only within this same posed-skin measurement.
          if (ref.measuredAt !== epoch) {
            skinReader.getVertexPosition(ref.skin, ref.vertex, point).applyMatrix4(ref.skin.matrixWorld);
            if (!Number.isFinite(point.y)) throw new Error('Nonfinite prone support skin');
            ref.height = point.y; ref.measuredAt = epoch;
          }
          if (ref.height < minimumY) { minimumY = ref.height; witness = ref; }
        }
        measured[region] = { minimumY, gapM: 0, mesh: witness.skin.name, vertex: witness.vertex, dominantBone: witness.bone };
        witnessRefs.set(measured[region], witness);
      }
      for (const record of Object.values(measured)) record.gapM = record.minimumY - measured.pelvis.minimumY;
      return measured;
    });
  }
  function probeWitnesses(side: Side, current: Record<Region, ProneSkinWitness>) {return timed("probeWitnesses",()=>probeWitnessesInner(side,current));}
  function probeWitnessesInner(side: Side, current: Record<Region, ProneSkinWitness>) {
    return sampleSkin(() => {
      refreshWorld();
      skinReader.beginMeasurement();
      const keys = ['pelvis', `${side}_thighCalf`, `${side}_toes`] as const;
      const refs = keys.map(key => witnessRefs.get(current[key])!);
      const heights = refs.map(ref => skinReader.getVertexPosition(ref.skin, ref.vertex, point).applyMatrix4(ref.skin.matrixWorld).y);
      return [heights[1]! - heights[0]!, heights[2]! - heights[0]!];
    });
  }
  function solve({ constraints = null, floorY = 0 }: { constraints?: RomScenarioConstraints | null; floorY?: number } = {}): ProneSkinSupportResult {
    if (!Number.isFinite(floorY)) throw new Error('Prone support requires a finite support plane');
    refreshWorld();
    const source = timed('serialize',()=>serializeCustomPose(skinned.skeleton, variantCfg, variantCfg.id));
    // Root translation changes neither relative skin gaps nor the required
    // joint correction. Orientation, scale, ALL bone locals (including skin
    // helpers), patient bounds and mutable mesh inputs do. No rounded keys.
    const sourceKey = timed("key",()=>JSON.stringify({
      orientation: root.getWorldQuaternion(new THREE.Quaternion()).toArray(), scale: root.getWorldScale(new THREE.Vector3()).toArray(),
      bones: skinned.skeleton.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]),
      skin: skins.map(skin => ({ version: skin.geometry.getAttribute('position') instanceof THREE.InterleavedBufferAttribute ? (skin.geometry.getAttribute('position') as THREE.InterleavedBufferAttribute).data.version : (skin.geometry.getAttribute('position') as THREE.BufferAttribute).version, morphs: skin.morphTargetInfluences,
        local: [...skin.position.toArray(), ...skin.quaternion.toArray(), ...skin.scale.toArray()] })), constraints,
    }));
    const originalOwned = new Map(ownedKeys.map(key => [key, bones.get(key)!.quaternion.clone()]));
    const reasons: string[] = [];
    const bound = (joint: string, field: string, value: number) => {
      const range = getEffectiveRomRange(constraints, joint, field);
      if (!range || !Number.isFinite(value)) throw new Error(`Missing prone support clinical range ${joint}.${field}`);
      const result = THREE.MathUtils.clamp(value, range.min, range.max);
      return result;
    };
    const controlledFields = [['Spine_Upper', 'flexion'], ...(['L', 'R'] as const).flatMap(side =>
        [['UpLeg', 'hipFlexion'], ['Leg', 'kneeFlexion'], ['Foot', 'ankleFlexion'], ['Toes', 'toeFlexion']]
          .map(([part, field]) => [`${side}_${part}`, field!]))];
    const finish = (measured: Record<Region, ProneSkinWitness>, iterations: number): ProneSkinSupportResult => {
      const actual = timed('angles',()=>computeJointAngles(skinned.skeleton, variantCfg, variantCfg.id, rest).joints);
      const activeLimits: string[] = [], violatedLimits: string[] = [];
      for (const [joint, field] of controlledFields) {
        const value = actual[joint!]?.[field!], range = getEffectiveRomRange(constraints, joint!, field!);
        if (value === undefined || !range || value < range.min - .0001 || value > range.max + .0001) violatedLimits.push(`${joint}.${field} outside clinical or patient range`);
        if (value !== undefined && range && (Math.abs(value - range.min) <= .0001 || Math.abs(value - range.max) <= .0001)) activeLimits.push(`${joint}.${field}`);
      }
      const support = ['L_thighCalf', 'R_thighCalf', 'L_toes', 'R_toes'] as const;
      const clearance = ['torso', 'head', 'L_leg', 'R_leg'] as const;
      const tolerance = PRONE_SKIN_SUPPORT_NUMERICS.toleranceM;
      const feasible = !violatedLimits.length && support.every(key => Math.abs(measured[key].gapM) <= tolerance) && clearance.every(key => measured[key].gapM >= -tolerance);
      for (const key of support) if (Math.abs(measured[key].gapM) > tolerance) reasons.push(`${key} support residual`);
      for (const key of clearance) if (measured[key].gapM < -tolerance) reasons.push(`${key} below pelvis support`);
      return { feasible, reusedSolution: false, iterations, pelvisMinimumY: measured.pelvis.minimumY, requiredRootTranslationM: floorY - measured.pelvis.minimumY, regions: measured,
        correctedDegrees: { thoracicFlexion: actual.Spine_Upper!.flexion!, L_hipFlexion: actual.L_UpLeg!.hipFlexion!, R_hipFlexion: actual.R_UpLeg!.hipFlexion!,
          L_kneeFlexion: actual.L_Leg!.kneeFlexion!, R_kneeFlexion: actual.R_Leg!.kneeFlexion! },
        activeLimits, reasons: feasible ? [] : [...new Set([...reasons, ...violatedLimits])],
        scope: 'Geometric pelvis, full thigh/calf and toe skin support only. Distal-envelope and knee-band clearance remain separate diagnostics. Root, hands, source ankle/toe posture within bounds, force, compression and motion acceptance remain separate.' };
    };
    const remember = (result: ProneSkinSupportResult) => {
      if (result.feasible) {
        cache.delete(sourceKey);
        cache.set(sourceKey, { pose: new Map(ownedKeys.map(key => [key, bones.get(key)!.quaternion.clone()])) });
        if (cache.size > 64) cache.delete(cache.keys().next().value!);
      }
      return result;
    };
    const cached = cache.get(sourceKey);
    if((globalThis as any).__proneCost)(globalThis as any).__proneCost.cacheHit=!!cached;
    if (cached) {
      for (const [key, quaternion] of cached.pose) bones.get(key)!.quaternion.copy(quaternion);
      const result = finish(measure(), 0);
      if (result.feasible) {
        cache.delete(sourceKey); cache.set(sourceKey, cached);
        return { ...result, reusedSolution: true };
      }
      // Even a cache hit re-measures skin. A changed unsupported input must not
      // turn an old geometric solution into a claim of current feasibility.
      for (const [key, quaternion] of originalOwned) bones.get(key)!.quaternion.copy(quaternion);
      cache.delete(sourceKey); reasons.length = 0;
    }
    const currentGeometry = finish(measure(), 0);
    // Use the same measured geometry and clinical/patient verdict as the final
    // solve and cache replay. A stricter second check re-solved valid boundary
    // poses because of Float32 readback noise, changing already supported legs.
    if((globalThis as any).__proneCost)(globalThis as any).__proneCost.sourceFeasible=currentGeometry.feasible;
    if (currentGeometry.feasible) return remember(currentGeometry);
    reasons.length = 0;
    // Feasible poses already have their current readout in finish(). Capture
    // the source coordinates only when a new correction is actually needed.
    const angles = timed('angles',()=>computeJointAngles(skinned.skeleton, variantCfg, variantCfg.id, rest).joints);
    const sagittal = (key: string, field: string, degrees: number) => {
      const row = angles[key] ?? {}, targets = [{ motion: field, degrees }];
      if (key.endsWith('_UpLeg')) targets.push({ motion: 'hipAbduction', degrees: row.hipAbduction ?? 0 }, { motion: 'hipRotation', degrees: row.hipRotation ?? 0 });
      if (key.endsWith('_Leg')) targets.push({ motion: 'kneeRotation', degrees: row.kneeRotation ?? 0 });
      if (key.endsWith('_Foot')) targets.push({ motion: 'ankleInversion', degrees: row.ankleInversion ?? 0 }, { motion: 'ankleAbduction', degrees: row.ankleAbduction ?? 0 });
      const pose = timed('buildCommand',()=>buildComposedCommandPose(baselinePose, key, targets, variantCfg, source, rest));
      if (!pose?.bones[key]) throw new Error(`Unsupported prone support coordinate ${key}.${field}`);
      bones.get(key)!.quaternion.fromArray(pose.bones[key]!);
      if (key.endsWith('_UpLeg')) clampMeasuredPatientHip(bones.get(key)!, key, rest, constraints);
      if (key.endsWith('_Leg')) clampMeasuredPatientHinge(bones.get(`${key[0]}_UpLeg`)!, bones.get(key)!, key, rest, constraints);
    };
    // Ankle/toe pose remains authored when in range. A tightened patient range
    // can restrict it, but the solver cannot use these joints to invent reach.
    for (const side of ['L', 'R'] as const) for (const [part, field] of [['Foot', 'ankleFlexion'], ['Toes', 'toeFlexion']] as const) {
      const key = `${side}_${part}`, value = angles[key]?.[field] ?? 0, allowed = bound(key, field, value);
      if (Math.abs(allowed - value) > 1e-8) sagittal(key, field, allowed);
    }
    const thoracicBase = angles.Spine_Upper?.flexion ?? 0;
    let thoracic = bound('Spine_Upper', 'flexion', thoracicBase), iterations = 0;
    const thoracicRest = ['Spine_Mid', 'Spine_Upper'].map(key => {
      const restQ = new THREE.Quaternion().fromArray(rest.localQuats[key]!);
      return { key, restQ, euler: new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(source.bones[key]!).multiply(restQ.clone().invert()), 'YXZ') };
    });
    const setThoracic = (value: number) => {
      thoracic = bound('Spine_Upper', 'flexion', value);
      for (const item of thoracicRest) bones.get(item.key)!.quaternion.setFromEuler(new THREE.Euler(item.euler.x + (thoracic - thoracicBase) * Math.PI / 360, item.euler.y, item.euler.z, 'YXZ')).multiply(item.restQ);
    };
    setThoracic(thoracic);
    let measured = measure(['torso']);
    const numerics = PRONE_SKIN_SUPPORT_NUMERICS;
    // Only add the extension needed for the actual torso to clear a pelvis
    // support plane. This is geometry-derived, with no model-name offsets.
    if (measured.torso.gapM < 0) {
      const lower = getEffectiveRomRange(constraints, 'Spine_Upper', 'flexion')!.min;
      let safe = thoracic, unsafe = thoracic;
      while (safe > lower + 1e-8 && measured.torso.gapM < 0) {
        unsafe = safe; safe = Math.max(lower, safe - numerics.maximumStepDeg); setThoracic(safe); measured = measure(['torso']); iterations++;
      }
      if (measured.torso.gapM >= 0) {
        for (let i = 0; i < 12 && unsafe - safe > .0001; i++) {
          const middle = (safe + unsafe) / 2; setThoracic(middle); const next = measure(['torso']);
          if (next.torso.gapM >= 0) safe = middle; else unsafe = middle;
        }
        setThoracic(safe);
      } else reasons.push('Torso remains below pelvis support within thoracic range');
    }
    const coordinates = {} as Record<Side, { hip: number; knee: number }>;
    // Both thighs can influence the pelvis support vertex through skin weights.
    // Revisit the first leg after the opposite leg moves instead of treating
    // the two references as independent or tolerating the resulting penetration.
    for (let couplingPass = 0; couplingPass < 3; couplingPass++) {
    for (const side of ['L', 'R'] as const) {
      const hipKey = `${side}_UpLeg`, kneeKey = `${side}_Leg`;
      let hip = coordinates[side]?.hip ?? bound(hipKey, 'hipFlexion', angles[hipKey]?.hipFlexion ?? 0), knee = coordinates[side]?.knee ?? bound(kneeKey, 'kneeFlexion', angles[kneeKey]?.kneeFlexion ?? 0);
      const readLeg = () => {
        const m = measure([`${side}_thighCalf`, `${side}_toes`]);
        return { residual: [m[`${side}_thighCalf`].gapM, m[`${side}_toes`].gapM], measured: m };
      };
      const evaluate = (h: number, k: number) => {
        sagittal(hipKey, 'hipFlexion', h); sagittal(kneeKey, 'kneeFlexion', k);
        return readLeg();
      };
      const derivativeProbe = (h: number, k: number, witnesses: Record<Region, ProneSkinWitness>) => {
        sagittal(hipKey, 'hipFlexion', h); sagittal(kneeKey, 'kneeFlexion', k);
        // Differentiate the active skin witnesses, then rescan complete regions
        // for every trial step. Switching minima and tied witnesses therefore
        // cannot be accepted on this local linear approximation alone.
        return probeWitnesses(side, witnesses);
      };
      // The source's geometric knee readout includes its rest bend, whereas
      // the command builder's parameter is relative to its local rest frame.
      // Establish the same parameterization for the current point and probes;
      // reading the untouched source here gives an inconsistent Jacobian.
      let current = coordinates[side] ? readLeg() : evaluate(hip, knee);
      const bestHip = bones.get(hipKey)!.quaternion.clone(), bestKnee = bones.get(kneeKey)!.quaternion.clone();
      for (let iteration = 0; iteration < numerics.maximumIterations && Math.max(...current.residual.map(Math.abs)) > numerics.toleranceM; iteration++) {
        iterations++;
        const probe = (value: number, key: string, field: string) => {
          const plus = bound(key, field, value + numerics.derivativeStepDeg);
          return Math.abs(plus - value) > 1e-8 ? plus : bound(key, field, value - numerics.derivativeStepDeg);
        };
        const ph = probe(hip, hipKey, 'hipFlexion'), pk = probe(knee, kneeKey, 'kneeFlexion');
        if (Math.abs(ph - hip) < 1e-8 || Math.abs(pk - knee) < 1e-8) { reasons.push(`${side} leg support is restricted by patient range`); break; }
        const dh = derivativeProbe(ph, knee, current.measured).map((value, i) => (value - current.residual[i]!) / (ph - hip));
        const dk = derivativeProbe(hip, pk, current.measured).map((value, i) => (value - current.residual[i]!) / (pk - knee));
        const determinant = dh[0]! * dk[1]! - dk[0]! * dh[1]!;
        if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) { reasons.push(`${side} support geometry is singular`); break; }
        const hStep = (-current.residual[0]! * dk[1]! + dk[0]! * current.residual[1]!) / determinant;
        const kStep = (-dh[0]! * current.residual[1]! + current.residual[0]! * dh[1]!) / determinant;
        const scale = Math.min(1, numerics.maximumStepDeg / Math.max(Math.abs(hStep), Math.abs(kStep)));
        let accepted = false;
        for (let trial = 0; trial < 8; trial++) {
          const h = bound(hipKey, 'hipFlexion', hip + hStep * scale / 2 ** trial), k = bound(kneeKey, 'kneeFlexion', knee + kStep * scale / 2 ** trial), next = evaluate(h, k);
          if (Math.hypot(...next.residual) < Math.hypot(...current.residual) - 1e-10) { hip = h; knee = k; current = next; bestHip.copy(bones.get(hipKey)!.quaternion); bestKnee.copy(bones.get(kneeKey)!.quaternion); accepted = true; break; }
        }
        if (!accepted) { reasons.push(`${side} support has no decreasing bounded step`); break; }
      }
      bones.get(hipKey)!.quaternion.copy(bestHip); bones.get(kneeKey)!.quaternion.copy(bestKnee); coordinates[side] = { hip, knee };
    }
    measured = measure();
    if (['L_thighCalf', 'R_thighCalf', 'L_toes', 'R_toes'].every(key => Math.abs(measured[key as Region].gapM) <= numerics.toleranceM)) break;
    }
    return remember(finish(measured, iterations));
  }
  return { pelvisSurface, measure, solve };
}
