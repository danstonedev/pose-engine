import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { buildSequencePoses, resolveComposedMotion } from '../services/motionSequence';
import { createProneSkinSupport } from '../services/proneSkinSupport';
import { isRomClampActive, setRomClampEnabled } from '../services/poseRomClamp';
import { SkinContact } from '../services/skinContact';

let previousClamp: boolean;
beforeEach(() => { previousClamp = isRomClampActive(); setRomClampEnabled(false); });
afterEach(() => { setRomClampEnabled(previousClamp); vi.restoreAllMocks(); });

async function fixture(variant: 'male' | 'female' | 'neutral' = 'male') {
  const variantCfg = BODY_VARIANTS[variant], bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  applyAnatomicPose(root, variantCfg); root.updateMatrixWorld(true);
  const skins: THREE.SkinnedMesh[] = [];
  root.traverse(node => { if ((node as THREE.SkinnedMesh).isSkinnedMesh) skins.push(node as THREE.SkinnedMesh); });
  const skinned = skins[0]!, baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, variant);
  const rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  const sequence = buildSequencePoses(baselinePose, resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), variantCfg), variantCfg, rest);
  const pose = sequence.poses[1]!;
  root.quaternion.fromArray(sequence.roots[1]!.quat);
  applyCustomPose(skinned.skeleton, variantCfg, pose); root.updateMatrixWorld(true);
  const options = { root, skinned, variantCfg, baselinePose, rest };
  const support = createProneSkinSupport(options);
  return { ...options, skins, support, options, pose };
}

async function compareAfterEdit(edit: (rig: Awaited<ReturnType<typeof fixture>>) => void, variant: 'male' | 'female' | 'neutral' = 'male') {
  const rig = await fixture(variant), { support, skinned, variantCfg, root } = rig;
  const surface = support.pelvisSurface, meshArray = surface.meshes;
  const retainedVertices = meshArray.map(entry => ({ skin: entry.skin, vertices: entry.vertices }));
  support.solve(); // Populate the old-input solution cache when feasible.
  edit(rig);
  applyCustomPose(skinned.skeleton, variantCfg, rig.pose); root.updateMatrixWorld(true);
  const before = serializeCustomPose(skinned.skeleton, variantCfg, variant);
  const warmMeasure = support.measure();
  expect(serializeCustomPose(skinned.skeleton, variantCfg, variant)).toEqual(before);
  const fresh = createProneSkinSupport(rig.options);
  expect(warmMeasure).toEqual(fresh.measure());
  expect(support.pelvisSurface).toBe(surface);
  expect(support.pelvisSurface.meshes).toBe(meshArray);
  for (const entry of retainedVertices) {
    const current = meshArray.find(item => item.skin === entry.skin);
    if (current) expect(current.vertices).toBe(entry.vertices);
  }
  const warmResult = support.solve(), warmPose = serializeCustomPose(skinned.skeleton, variantCfg, variant);
  applyCustomPose(skinned.skeleton, variantCfg, before); root.updateMatrixWorld(true);
  const freshResult = fresh.solve();
  expect(warmResult).toEqual(freshResult);
  expect(serializeCustomPose(skinned.skeleton, variantCfg, variant)).toEqual(warmPose);
  return rig;
}

describe('prone support authoritative input changes', () => {
  it.each(['male', 'female', 'neutral'] as const)('%s reclassifies a changed pelvis skin owner exactly like a new helper', async variant => {
    await compareAfterEdit(({ support, root }) => {
      const witness = support.measure().pelvis, mesh = root.getObjectByName(witness.mesh) as THREE.SkinnedMesh;
      const ids = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
      let slot = 0;
      for (let i = 1; i < weights.itemSize; i++) if (weights.getComponent(witness.vertex, i) > weights.getComponent(witness.vertex, slot)) slot = i;
      const waist = mesh.skeleton.bones.findIndex(bone => /Waist$/.test(bone.name));
      expect(waist).toBeGreaterThanOrEqual(0);
      ids.setComponent(witness.vertex, slot, waist); ids.needsUpdate = true;
    }, variant);
  });

  it.each(['replacement position', 'skin weights', 'inverse binding', 'anatomical reference', 'clinical reference', 'root scale', 'helper transform'] as const)('refreshes %s inputs and clears old solutions', async kind => {
    await compareAfterEdit(({ support, skinned, root, baselinePose, rest }) => {
      const witness = support.measure().pelvis, mesh = root.getObjectByName(witness.mesh) as THREE.SkinnedMesh;
      if (kind === 'replacement position') {
        const original = mesh.geometry.getAttribute('position'), replacement = original.clone();
        replacement.setY(witness.vertex, replacement.getY(witness.vertex) + 1);
        expect(replacement instanceof THREE.BufferAttribute && replacement.version).toBe(0);
        mesh.geometry.setAttribute('position', replacement);
      } else if (kind === 'skin weights') {
        const weights = mesh.geometry.getAttribute('skinWeight');
        const row = Array.from({ length: weights.itemSize }, (_, slot) => weights.getComponent(witness.vertex, slot));
        row.forEach((_, slot) => weights.setComponent(witness.vertex, slot, row[(slot + 1) % row.length]!));
        weights.needsUpdate = true;
      } else if (kind === 'inverse binding') {
        const index = skinned.skeleton.bones.findIndex(bone => /Pelvis$/.test(bone.name));
        skinned.skeleton.boneInverses[index]!.elements[12]! += .5;
      } else if (kind === 'anatomical reference') {
        baselinePose.bones.L_UpLeg = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .05)
          .multiply(new THREE.Quaternion().fromArray(baselinePose.bones.L_UpLeg!)).toArray();
      } else if (kind === 'clinical reference') {
        rest.localQuats.L_UpLeg = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .01)
          .multiply(new THREE.Quaternion().fromArray(rest.localQuats.L_UpLeg!)).toArray();
      } else if (kind === 'root scale') root.scale.y *= 1.05;
      else {
        const helper = skinned.skeleton.bones.find(bone => /L_ThighTwist/.test(bone.name));
        expect(helper).toBeDefined(); helper!.position.z += .1;
      }
    });
  });

  it('does not rebuild membership during posed motion, restored render compression, or exactly restored attribute writes', async () => {
    const { root, skins, skinned, variantCfg, support, pose } = await fixture();
    const contact = new SkinContact(root);
    const ownershipReads = skins.map(skin => vi.spyOn(skin.geometry.getAttribute('skinWeight'), 'getComponent'));
    const measureWithoutRebuild = () => {
      ownershipReads.forEach(spy => spy.mockClear());
      support.measure();
      expect(ownershipReads.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(0);
    };
    const originalGeometries = skins.map(skin => skin.geometry);
    const versions = originalGeometries.map(geometry => (geometry.getAttribute('position') as THREE.BufferAttribute).version);
    let compressedFrames = 0;
    for (let frame = 0; frame < 8; frame++) {
      applyCustomPose(skinned.skeleton, variantCfg, pose);
      root.position.set(frame * .03, 0, -.1);
      root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), frame * .05);
      root.updateMatrixWorld(true);
      measureWithoutRebuild();
      contact.update();
      contact.support(contact.lowest() + .001, undefined, true, .002);
      contact.finish();
      if (skins.some((skin, i) => skin.geometry !== originalGeometries[i])) compressedFrames++;
      contact.restore(); root.updateMatrixWorld(true);
      measureWithoutRebuild();
    }
    expect(compressedFrames).toBe(8);
    expect(originalGeometries.map(geometry => (geometry.getAttribute('position') as THREE.BufferAttribute).version)).toEqual(versions);
    for (const skin of skins) {
      const position = skin.geometry.getAttribute('position'), original = position.getX(0);
      position.setX(0, original + .1); position.needsUpdate = true;
      position.setX(0, original); position.needsUpdate = true;
    }
    measureWithoutRebuild();
    contact.dispose();
  });
});
