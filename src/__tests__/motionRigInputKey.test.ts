import { expect, it } from 'vitest';
import * as THREE from 'three';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { POSE_SCHEMA_VERSION, type CustomPose } from '../types';
import { resolveComposedMotion } from '../services/motionSequence';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { motionRigInputKey } from '../services/motionRigInputKey';

function fixture() {
  const root = new THREE.Group(), parent = new THREE.Group(), skinned = new THREE.SkinnedMesh();
  skinned.bind(new THREE.Skeleton([])); root.add(skinned); parent.add(root);
  skinned.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  skinned.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
  const baselinePose: CustomPose = { schemaVersion: POSE_SCHEMA_VERSION, variant: 'male', bones: {} };
  const options = {
    resolvedMotion: resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R')),
    baselinePose, variantCfg: BODY_VARIANTS.male, skeletonHarness: { root, skinned },
    rest: { pelvisWorldQuat: [0, 0, 0, 1] as [number, number, number, number], worldQuats: {}, localQuats: {} },
    rootTransform: { position: root.position.clone(), quaternion: root.quaternion.clone(), scale: root.scale.clone() },
  };
  return { root, parent, skinned, options };
}

it('invalidates support guides for geometry, morphology, support configuration and ancestor edits', () => {
  const { parent, skinned, options } = fixture();
  const edits = [
    () => { const p = skinned.geometry.getAttribute('position'); p.setY(0, .005); p.needsUpdate = true; },
    () => { const w = skinned.geometry.getAttribute('skinWeight'); w.setX(0, .9); w.needsUpdate = true; },
    () => { skinned.morphTargetInfluences = [.2]; },
    () => { skinned.geometry.morphTargetsRelative = true; },
    () => { skinned.bindMatrix.elements[12] = .001; },
    () => { options.resolvedMotion.proneSkinSupport = false; },
    () => { options.resolvedMotion.fixedGroundSupports = []; },
    () => { parent.position.x += .1; },
  ];
  for (const edit of edits) {
    const before = motionRigInputKey(options);
    edit();
    expect(motionRigInputKey(options)).not.toBe(before);
  }
});

it('uses the root transform restored by probes while preserving unowned helper state', () => {
  const { root, options } = fixture();
  const helper = new THREE.Bone(); helper.name = 'Unowned helper'; root.add(helper);
  const before = motionRigInputKey(options);
  root.position.set(3, 4, 5); root.rotateX(.4); root.scale.multiplyScalar(1.01);
  expect(motionRigInputKey(options)).toBe(before);
  helper.rotateY(.1);
  const changedHelper = motionRigInputKey(options);
  expect(changedHelper).not.toBe(before);
  options.rootTransform.position.x += .01;
  expect(motionRigInputKey(options)).not.toBe(changedHelper);
});
