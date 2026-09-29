/** Raw AROM screens must establish and HOLD their stated measurement setup. */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { measureCommandMotion } from '../services/movementCommand';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type RecordedFrame } from '../services/motionRecording';
import { captureFloorReference, GROUNDING_BLEND_MS } from '../services/rootMotion';
import { MOVEMENT_TEMPLATES } from '../services/movementTemplates.data';
import { templateToComposedMotion } from '../services/movementTemplateMotion';
import type { CustomPose } from '../types';

const screens = ['shoulder-rotation', 'forearm-rotation', 'tibial-rotation'] as const;
const opposite = (side: 'L' | 'R') => side === 'L' ? 'R' : 'L';
const sided = (joint: string, side: 'L' | 'R') => side === 'R' ? joint
  : joint.replace(/^[LR]_/, prefix => prefix === 'R_' ? 'L_' : 'R_');

for (const variant of ['male', 'female', 'neutral'] as const) {
  describe(`${variant}: rotation screens on the runtime rig`, () => {
    const variantCfg = BODY_VARIANTS[variant];
    let root: THREE.Object3D;
    let skinned: THREE.SkinnedMesh;
    let rest: JointAngleRestReference;
    let baselinePose: CustomPose;
    let floorY: number;

    beforeAll(async () => {
      const buf = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
      const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => loader.parse(bytes, '', resolve, reject));
      root = gltf.scene;
      root.scale.setScalar(variantCfg.pose.rootScale);
      root.traverse(object => {
        if ((object as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = object as THREE.SkinnedMesh;
      });
      root.updateMatrixWorld(true);
      applyAnatomicPose(root, variantCfg);
      root.updateMatrixWorld(true);
      rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
      baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, variant);
      floorY = captureFloorReference(skinned.skeleton, variantCfg).floorY;
    });

    const angle = (frame: RecordedFrame, joint: string, motion: string) => {
      const value = measureCommandMotion({ at: '', variant, joints: frame.angles }, joint, motion);
      expect(value, `${joint}.${motion} is measurable`).not.toBeNull();
      return value!;
    };

    for (const id of screens) for (const side of ['L', 'R'] as const) {
      it(`${side} ${id}: holds setup through both sweep directions and returns to neutral`, () => {
        applyAnatomicPose(root, variantCfg);
        root.position.set(0, 0, 0);
        root.quaternion.identity();
        root.updateMatrixWorld(true);
        const template = MOVEMENT_TEMPLATES.find(t => t.id === id)!;
        const motion = templateToComposedMotion(template);
        // The library authors right-sided examples; hosts swap canonical side
        // prefixes without changing the clinical sign of the requested angle.
        motion.keyframes = motion.keyframes.map(frame => ({
          ...frame,
          targets: frame.targets?.map(target => ({ ...target, joint: sided(target.joint, side) })),
        }));
        const resolved = resolveComposedMotion(motion, variantCfg);
        expect(resolved.status).toBe('ok');
        const recording = sampleComposedMotion(resolved, {
          baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30,
        });
        const nearest = (ms: number) => recording.frames.reduce((a, b) => Math.abs(a.tMs - ms) < Math.abs(b.tMs - ms) ? a : b);
        let ms = 0;
        for (const phase of template.phases) {
          ms += phase.durationMs;
          const frame = nearest(ms);
          for (const target of phase.targets) {
            const joint = sided(target.joint, side);
            expect(Math.abs(angle(frame, joint, target.motion) - target.peakDeg),
              `${phase.name}: ${joint}.${target.motion} reaches ${target.peakDeg} degrees`).toBeLessThan(5);
          }
          ms += phase.holdMs ?? 0;
        }

        const setupEnd = template.phases.slice(0, id === 'tibial-rotation' ? 2 : 1)
          .reduce((total, phase) => total + phase.durationMs + (phase.holdMs ?? 0), 0);
        const returnStart = ms - template.phases.at(-1)!.durationMs;
        const sweep = recording.frames.filter(frame => frame.tMs >= setupEnd && frame.tMs <= returnStart);
        const held = id === 'shoulder-rotation'
          ? [[`${side}_UpperArm`, 'shoulderAbduction', 90], [`${side}_Forearm`, 'elbowFlexion', 90]] as const
          : id === 'forearm-rotation'
            ? [[`${side}_UpperArm`, 'shoulderFlexion', 0], [`${side}_UpperArm`, 'shoulderAbduction', 0], [`${side}_Forearm`, 'elbowFlexion', 90]] as const
            : [[`${side}_UpLeg`, 'hipFlexion', 90], [`${opposite(side)}_UpLeg`, 'hipFlexion', 90], [`${side}_Leg`, 'kneeFlexion', 90], [`${opposite(side)}_Leg`, 'kneeFlexion', 90]] as const;
        for (const frame of sweep) {
          for (const [joint, motion, degrees] of held) {
            expect(Math.abs(angle(frame, joint, motion) - degrees), `${frame.tMs} ms: hold ${joint}.${motion}`).toBeLessThan(5);
          }
          if (id === 'tibial-rotation') expect(frame.groundingPosture).toBe('sitting');
        }
        // A supported screen must not drift the seat or the planted feet while
        // the tested limb rotates. This inspects world geometry, not metadata.
        const support = id === 'tibial-rotation' ? ['Hips'] : ['L_Foot', 'R_Foot'];
        // The existing grounding solver crossfades support around the start of
        // standing. The seated sweep ends before that intentional hand-off.
        const supportedSweep = sweep.filter(frame => frame.tMs < returnStart - GROUNDING_BLEND_MS / 2);
        for (const key of support) {
          const start = new THREE.Vector3(...supportedSweep[0]!.worldTracks![key]!);
          for (const frame of supportedSweep) {
            expect(new THREE.Vector3(...frame.worldTracks![key]!).distanceTo(start), `${key} support drift at ${frame.tMs} ms`).toBeLessThan(0.005);
          }
        }
        expect(recording.frames.at(-1)!.groundingPosture).toBeUndefined();
        if (id === 'tibial-rotation') {
          for (const frame of recording.frames) {
            for (const key of ['L_Foot', 'R_Foot']) {
              expect(frame.worldTracks![key]![1] - floorY, `${key} clearance during entry/sweep/return at ${frame.tMs} ms`).toBeGreaterThan(-0.02);
            }
          }
        }
      });
    }
  });
}
