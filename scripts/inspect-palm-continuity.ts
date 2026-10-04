import * as THREE from 'three';
import {loadHandRig} from '../src/__tests__/handPlantCases';
import {BODY_VARIANTS} from '../src/anatomy/bodyVariants';
import {buildPushUp} from '../src/services/movementPostures';
import {resolveComposedMotion} from '../src/services/motionSequence';
import {sampleComposedMotion} from '../src/services/motionRecording';
for (const variant of ['male', 'female'] as const) {
  const rig = await loadHandRig(variant);
  const motion = buildPushUp();
  const frames = sampleComposedMotion(resolveComposedMotion(motion, BODY_VARIANTS[variant]), {
    baselinePose: rig.baselinePose, variantCfg: BODY_VARIANTS[variant], rest: rig.rest,
    skeletonHarness: {root: rig.root, skinned: rig.skinned}, sampleHz: 60,
  }).frames;
  for (const key of ['L_UpperArm','R_UpperArm','L_Forearm','R_Forearm']) {
    const turns = frames.map((frame, i) => ({ t: frame.tMs, turn: i ? new THREE.Quaternion().fromArray(frame.pose.bones[key]!).angleTo(new THREE.Quaternion().fromArray(frames[i-1]!.pose.bones[key]!)) * 180 / Math.PI : 0 }));
    console.log(JSON.stringify({variant,key,turns:turns.sort((a,b)=>b.turn-a.turn).slice(0,8)}));
  }
}
