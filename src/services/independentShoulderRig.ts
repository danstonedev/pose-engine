import * as THREE from 'three';
import {SHOULDER_RIG_ASSET_HASHES} from '../anatomy/shoulderRigAssets';
import {getBodyVariant, type BodyVariantConfig, type BodyVariantId} from '../anatomy/bodyVariants';
import {POSE_SCHEMA_VERSION, type CustomPose} from '../types';
import {buildBoneByPoseKey} from './poseRig';

export const INDEPENDENT_SHOULDER_RIG = 'shoulder-v2-engineering-1' as const;
export type ShoulderSide = 'L' | 'R';
export type SegmentQuaternion = [number, number, number, number];
export const independentShoulderVariant = (id: BodyVariantId): BodyVariantConfig => ({
  ...getBodyVariant(id), rigVersion: INDEPENDENT_SHOULDER_RIG, rigAssetSha256: SHOULDER_RIG_ASSET_HASHES[id],
  modelUrl: base => `${base}/models/painmap3D_${id}.shoulder-v2.glb`,
});

export interface IndependentShoulderReference {
  version: typeof INDEPENDENT_SHOULDER_RIG;
  calibration: 'engineering-estimate-unreviewed';
  assetSha256: string;
  bones: Map<string, THREE.Bone>;
  frames: Record<string, THREE.Quaternion>;
  neutral: Record<string, SegmentQuaternion>;
}
const quat = (q: SegmentQuaternion) => {
  if (q.length !== 4 || !q.every(Number.isFinite) || Math.abs(Math.hypot(...q)-1)>1e-5) throw new Error('Shoulder targets require finite unit quaternions');
  return new THREE.Quaternion(...q);
};
const tuple = (q: THREE.Quaternion): SegmentQuaternion => q.toArray();

/** Capture once after anatomic calibration. Frames are rest-aligned engineering
 * frames; no inferred ISB landmark frame or calibrated clinical angle is claimed. */
export function captureIndependentShoulderReference(skeleton: THREE.Skeleton, cfg: BodyVariantConfig): IndependentShoulderReference {
  const bones=buildBoneByPoseKey(skeleton,cfg), thorax=bones.get('Spine_Upper');
  if(cfg.rigVersion!==INDEPENDENT_SHOULDER_RIG||!thorax)throw new Error('Independent shoulder rig required');
  thorax.updateWorldMatrix(true,true); const common=new THREE.Quaternion();
  const frames: Record<string,THREE.Quaternion>={},neutral: Record<string,SegmentQuaternion>={};
  for(const key of ['Spine_Upper',...(['L','R'] as const).flatMap(side=>[`${side}_Shoulder`,`${side}_Scapula`,`${side}_UpperArm`])]){
    const bone=bones.get(key);if(!bone)throw new Error(`Missing independent shoulder segment ${key}`);
    frames[key]=bone.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(common);neutral[key]=tuple(bone.quaternion);
  }
  for(const side of ['L','R'])if(bones.get(`${side}_Scapula`)!.parent!==bones.get(`${side}_Shoulder`)||bones.get(`${side}_UpperArm`)!.parent!==bones.get(`${side}_Scapula`))throw new Error('Unsupported shoulder topology');
  return {version:INDEPENDENT_SHOULDER_RIG,assetSha256:cfg.rigAssetSha256!,calibration:'engineering-estimate-unreviewed',bones,frames,neutral};
}
const frame = (ref:IndependentShoulderReference,key:string) => ref.bones.get(key)!.getWorldQuaternion(new THREE.Quaternion()).multiply(ref.frames[key]);
const relative = (a:THREE.Quaternion,b:THREE.Quaternion) => a.clone().invert().multiply(b).normalize();
export function inspectIndependentShoulder(ref:IndependentShoulderReference,side:ShoulderSide){
  ref.bones.get('Spine_Upper')!.updateWorldMatrix(true,true);
  const T=frame(ref,'Spine_Upper'),C=frame(ref,`${side}_Shoulder`),S=frame(ref,`${side}_Scapula`),H=frame(ref,`${side}_UpperArm`);
  const rotations={SC:relative(T,C),AC:relative(C,S),ST:relative(T,S),GH:relative(S,H),HT:relative(T,H)};
  return {version:ref.version,calibration:ref.calibration,convention:'rest-aligned-segment-quaternions-v1',
    independentControls:['SC','AC','GH'],derivedObservations:['ST','HT'],
    rotations:Object.fromEntries(Object.entries(rotations).map(([key,q])=>[key,{quaternion:tuple(q),rotationMagnitudeDeg:q.angleTo(new THREE.Quaternion())*180/Math.PI}])) as Record<keyof typeof rotations,{quaternion:SegmentQuaternion;rotationMagnitudeDeg:number}>,
    closureErrorDeg:rotations.SC.clone().multiply(rotations.AC).angleTo(rotations.ST)*180/Math.PI};
}
export interface IndependentShoulderTargets {
  SC?: SegmentQuaternion; AC?: SegmentQuaternion; GH?: SegmentQuaternion;
  /** Relative to the thorax; explicit GH takes priority over this arm target. */
  HT?: SegmentQuaternion;
  /** Derived target: solved through AC only when AC is not explicitly given. */
  ST?: SegmentQuaternion;
}
/** Atomic segment composition. Explicit SC/AC/GH win, ST and HT residuals remain
 * observable. This kinematic controller does not simulate ST contact forces. */
export function applyIndependentShoulderTargets(ref:IndependentShoulderReference,side:ShoulderSide,targets:IndependentShoulderTargets){
  for(const q of Object.values(targets))quat(q); // Validate the entire command before any write.
  const measured=inspectIndependentShoulder(ref,side), T=frame(ref,'Spine_Upper');
  const SC=targets.SC?quat(targets.SC):quat(measured.rotations.SC.quaternion);
  const C=T.clone().multiply(SC);
  const AC=targets.AC?quat(targets.AC):targets.ST?SC.clone().invert().multiply(quat(targets.ST)):quat(measured.rotations.AC.quaternion);
  const S=C.clone().multiply(AC);
  const GH=targets.GH?quat(targets.GH):targets.HT?S.clone().invert().multiply(T.clone().multiply(quat(targets.HT))):quat(measured.rotations.GH.quaternion);
  const H=S.clone().multiply(GH);
  for(const [key,desired] of [[`${side}_Shoulder`,C],[`${side}_Scapula`,S],[`${side}_UpperArm`,H]] as const){
    const bone=ref.bones.get(key)!,world=desired.clone().multiply(ref.frames[key].clone().invert());
    bone.quaternion.copy(bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));bone.updateMatrixWorld(true);
  }
  const actual=inspectIndependentShoulder(ref,side);
  return {...actual,residualsDeg:{ST:targets.ST?quat(targets.ST).angleTo(quat(actual.rotations.ST.quaternion))*180/Math.PI:null,HT:targets.HT?quat(targets.HT).angleTo(quat(actual.rotations.HT.quaternion))*180/Math.PI:null}};
}

/** The v2 converter inserts an identity-rotation segment, retaining every old
 * bone's world bind transform. Explicit migration subtracts its local offset;
 * it does not reinterpret an old upper-arm position under a new parent. */
export function migrateLegacyShoulderPose(pose:CustomPose, ref:IndependentShoulderReference):CustomPose {
  if(pose.rigVersion&&pose.rigVersion!==INDEPENDENT_SHOULDER_RIG)throw new Error('Unsupported source rig version');
  if(pose.rigVersion===INDEPENDENT_SHOULDER_RIG){if(pose.rigAssetSha256!==ref.assetSha256)throw new Error('Shoulder asset identity mismatch');return structuredClone(pose);}
  if(pose.schemaVersion&&pose.schemaVersion!==POSE_SCHEMA_VERSION)throw new Error('Unsupported legacy pose schema');
  const migrated=structuredClone(pose);migrated.rigVersion=INDEPENDENT_SHOULDER_RIG;migrated.rigAssetSha256=ref.assetSha256;migrated.schemaVersion=POSE_SCHEMA_VERSION+'-shoulder-v2';
  migrated.positions={...migrated.positions};
  for(const side of ['L','R']){
    const scapula=ref.bones.get(`${side}_Scapula`)!;migrated.bones[`${side}_Scapula`]=[0,0,0,1];
    migrated.positions[`${side}_Scapula`]=scapula.position.toArray();
    const upperKey=`${side}_UpperArm`,old=pose.positions?.[upperKey];
    migrated.positions[upperKey]=old?new THREE.Vector3(...old).sub(scapula.position).toArray():ref.bones.get(upperKey)!.position.toArray();
  }
  return migrated;
}

/** External v1 clips require the same translation migration and explicit neutral
 * scapula tracks. The caller retains the original clip for v1 playback. */
export function migrateLegacyShoulderClip(clip:THREE.AnimationClip,ref:IndependentShoulderReference):THREE.AnimationClip {
  if(clip.tracks.some(track=>/_Scapula\./.test(track.name)))throw new Error('Clip already contains independent scapula tracks');
  const migrated=clip.clone();
  for(const side of ['L','R']){
    const scapula=ref.bones.get(`${side}_Scapula`)!,arm=ref.bones.get(`${side}_UpperArm`)!;
    for(const track of migrated.tracks)if(track.name===`${arm.name}.position`){for(let i=0;i<track.values.length;i++)track.values[i]-=scapula.position.getComponent(i%3);}
    migrated.tracks.push(new THREE.QuaternionKeyframeTrack(`${scapula.name}.quaternion`,[0,clip.duration],[0,0,0,1,0,0,0,1]),new THREE.VectorKeyframeTrack(`${scapula.name}.position`,[0,clip.duration],[...scapula.position.toArray(),...scapula.position.toArray()]));
  }
  return migrated;
}
