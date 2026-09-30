// The whole-body FMS/SFMA assessment motions, played on both body models — moved
// from simMOVE with the motions (src/__tests__/assessmentBodyMotions.test.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_ASSESSMENT_MOTIONS, BODY_ASSESSMENT_NOTES } from '../services/assessmentBodyMotions';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type RecordedFrame } from '../services/motionRecording';
import { movementScreenMotion, movementScreenPattern } from '../services/movementScreen';

const IDS = ['hurdle-step', 'in-line-lunge', 'rotary-stability', 'trunk-stability-push-up', 'extension-clearing', 'flexion-clearing', 'multisegmental-flexion', 'multisegmental-extension', 'multisegmental-rotation', 'single-leg-stance', 'sfma-overhead-deep-squat-legacy'];
const point = (frame: RecordedFrame, key: string) => new THREE.Vector3().fromArray(frame.worldTracks![key]!);

describe('assessment-specific whole-body source definitions', () => {
  it('covers the body assessments without replacing squat or ASLR controllers', () => {
    expect(Object.keys(BODY_ASSESSMENT_MOTIONS).sort()).toEqual([...IDS].sort());
    for (const id of IDS) expect(BODY_ASSESSMENT_NOTES[id]?.length).toBeGreaterThan(0);
  });

  it.each(IDS)('%s has an explicit setup, uniquely longest assessed hold and a return to setup', id => {
    for (const side of ['R', 'L'] as const) {
      const motion = BODY_ASSESSMENT_MOTIONS[id]!(side), frames = motion.keyframes;
      expect(frames.length).toBeGreaterThanOrEqual(3);
      const setup = id === 'sfma-overhead-deep-squat-legacy' ? frames[7]! : frames[0]!;
      expect(setup.targets).toEqual(frames.at(-1)!.targets);
      expect(setup.root?.translateM ?? [0,0,0]).toEqual(frames.at(-1)!.root?.translateM ?? [0,0,0]);
      expect(setup.groundingPosture).toEqual(frames.at(-1)!.groundingPosture);
      expect(motion.startPosture).toBe(motion.endPosture);
      const max = Math.max(...frames.map(frame => frame.holdMs ?? 0));
      expect(max).toBeGreaterThan(0);
      expect(frames.filter(frame => frame.holdMs === max)).toHaveLength(1);
      expect(frames[0]!.holdMs ?? 0).toBe(0);
      for (const frame of frames) {
        const joints = new Set<string>();
        for (const target of frame.targets ?? []) {
          expect(Number.isFinite(target.targetDegrees)).toBe(true);
          const key = `${target.joint}|${target.motion}`;
          expect(joints.has(key), `${id}: duplicate ${key}`).toBe(false);
          joints.add(key);
          if (target.joint.endsWith('_Shoulder')) expect(id === 'sfma-overhead-deep-squat-legacy' ? ['protraction','upRotation','scapularTilt'] : ['protraction']).toContain(target.motion);
        }
        // Imported whole-body support seeds explicitly clear quiet arm axes;
        // these body protocols still use only one nonzero humeral channel.
        for (const side of ['L', 'R']) expect(frame.targets!.filter(t => t.joint === `${side}_UpperArm` && t.targetDegrees !== 0).length).toBeLessThanOrEqual(id === 'sfma-overhead-deep-squat-legacy' ? 3 : 1);
      }
      const copy = BODY_ASSESSMENT_MOTIONS[id]!(side);
      frames[0]!.targets![0]!.targetDegrees = 999;
      expect(copy.keyframes[0]!.targets![0]!.targetDegrees).not.toBe(999);
    }
  });

  it('keeps the ten-second single-leg attempt and vision conditions separate', () => {
    expect(BODY_ASSESSMENT_MOTIONS['single-leg-stance']!('R').keyframes.map(frame => frame.holdMs ?? 0)).toEqual([0, 0, 10000, 0, 0]);
    expect(BODY_ASSESSMENT_NOTES['single-leg-stance']!.join(' ')).toMatch(/Eyes-open and eyes-closed are separate/);
  });
});

for (const variant of ['female', 'male'] as const) {
  describe(`${variant} source mannequin assessment geometry`, () => {
    const cfg = BODY_VARIANTS[variant];
    let root: THREE.Object3D, skinned: THREE.SkinnedMesh;
    let baseline: ReturnType<typeof serializeCustomPose>, rest: ReturnType<typeof captureJointAngleRestReference>;
    const initialPosition = new THREE.Vector3(), initialQuaternion = new THREE.Quaternion();
    beforeAll(async () => {
      const bytes = readFileSync(fileURLToPath(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url)));
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder); loader.parse(buffer, '', resolve as never, reject);
      });
      root = gltf.scene; root.scale.setScalar(cfg.pose.rootScale);
      root.traverse(object => { if (!skinned && (object as THREE.SkinnedMesh).isSkinnedMesh) skinned = object as THREE.SkinnedMesh; });
      root.updateMatrixWorld(true); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
      rest = captureJointAngleRestReference(skinned.skeleton, cfg);
      baseline = serializeCustomPose(skinned.skeleton, cfg, variant);
      initialPosition.copy(root.position); initialQuaternion.copy(root.quaternion);
    });

    function sample(motion: ComposedMotion) {
      root.position.copy(initialPosition); root.quaternion.copy(initialQuaternion);
      applyCustomPose(skinned.skeleton, cfg, baseline); root.updateMatrixWorld(true);
      const resolved = resolveComposedMotion(motion, cfg);
      expect(resolved.status).toBe('ok');
      const recording = sampleComposedMotion(resolved, { baselinePose: baseline, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz: 10 });
      let t = 0;
      const phases = resolved.keyframes.map(frame => {
        t += frame.durationMs;
        const at = recording.frames.reduce((best, value) => Math.abs(value.tMs - t) < Math.abs(best.tMs - t) ? value : best);
        t += frame.holdMs;
        return at;
      });
      return { resolved, recording, phases };
    }

    function footSkin(frame: RecordedFrame) {
      root.position.copy(initialPosition).add(new THREE.Vector3().fromArray(frame.root.translateM));
      root.quaternion.copy(initialQuaternion).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
      applyCustomPose(skinned.skeleton, cfg, frame.pose); root.updateMatrixWorld(true); skinned.skeleton.update();
      const bounds = { R: new THREE.Box3(), L: new THREE.Box3() };
      root.traverse(object => {
        const mesh = object as THREE.SkinnedMesh;
        if (!mesh.isSkinnedMesh) return;
        mesh.skeleton.update();
        const position = mesh.geometry.getAttribute('position'), indices = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
        const sides = mesh.skeleton.bones.map(bone => /_(R|L)_(?:Foot|.*Toe)/.exec(bone.name)?.[1]);
        for (let i = 0; i < position.count; i++) {
          const influence = { R: 0, L: 0 };
          for (let j = 0; j < 4; j++) {
            const side = sides[indices.getComponent(i, j)] as 'R' | 'L' | undefined;
            if (side) influence[side] += weights.getComponent(i, j);
          }
          for (const side of ['R', 'L'] as const) if (influence[side] > .5) bounds[side].expandByPoint(mesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(position, i)).applyMatrix4(mesh.matrixWorld));
        }
      });
      expect(bounds.R.isEmpty()).toBe(false); expect(bounds.L.isEmpty()).toBe(false);
      return { gap: bounds.L.min.x - bounds.R.max.x, minY: [bounds.L.min.y, bounds.R.min.y], ankleY: point(frame, 'R_Foot').y, toeY: point(frame, 'R_Toes').y };
    }

    it.each(IDS.flatMap(id => (['R', 'L'] as const).map(side => ({ id, side }))))('$id / $side follows the assessment path and returns to setup', ({ id, side }) => {
      const result = sample(BODY_ASSESSMENT_MOTIONS[id]!(side));
      for (const frame of result.recording.frames) {
        expect(Object.values(frame.worldTracks!).flat().every(Number.isFinite)).toBe(true);
        expect(frame.root.orientQuat.every(Number.isFinite)).toBe(true);
      }
      const start = result.phases[id === 'sfma-overhead-deep-squat-legacy' ? 7 : 0]!, finish = result.recording.frames.at(-1)!;
      for (const key of ['Hips', 'Head', 'L_Hand', 'R_Hand', 'L_Foot', 'R_Foot']) {
        expect(point(start, key).distanceTo(point(finish, key)), `${id}: return ${key}`).toBeLessThan(.08);
      }
      expect(result.resolved.outcomes.filter(outcome => outcome.status !== 'complied')).toEqual([]);
      const longestHold = Math.max(...result.resolved.keyframes.map(frame => frame.holdMs));
      const assessed = result.phases[result.resolved.keyframes.findIndex(frame => frame.holdMs === longestHold)]!;
      const support = side === 'R' ? 'L' : 'R';
      const at = (frame: RecordedFrame, suffix: string, which = side) => point(frame, `${which}_${suffix}`);

      if (id === 'hurdle-step') {
        const transfer = result.phases[1]!, lift = result.phases[2]!, cross = result.phases[3]!;
        expect(Math.abs(point(transfer, 'Hips').x - point(start, 'Hips').x)).toBeGreaterThan(.07);
        expect(Math.abs(at(transfer, 'Foot').y - at(start, 'Foot').y)).toBeLessThan(.02);
        expect(at(lift, 'Foot').y - at(start, 'Foot').y).toBeGreaterThan(.4);
        expect(at(cross, 'Foot').z - at(lift, 'Foot').z).toBeGreaterThan(.3);
        expect(at(assessed, 'Foot').z - at(start, 'Foot').z).toBeGreaterThan(.25);
        expect(at(assessed, 'Foot').y - at(start, 'Foot').y).toBeLessThan(.08);
        for (const phase of result.phases) expect(at(phase, 'Foot', support).distanceTo(at(start, 'Foot', support))).toBeLessThan(.02);
      } else if (id === 'in-line-lunge') {
        // Ankle origins can be level while the actual soles are not. Inspect
        // both weighted skin envelopes so a pitched, floating setup regresses.
        for (const phase of [start, finish]) {
          const skin = footSkin(phase);
          expect(Math.min(...skin.minY)).toBeGreaterThan(-.002);
          expect(Math.max(...skin.minY) - Math.min(...skin.minY)).toBeLessThan(.018);
        }
        const assessedSkin = footSkin(assessed);
        expect(Math.max(...assessedSkin.minY) - Math.min(...assessedSkin.minY)).toBeLessThan(.08);
        expect(at(start, 'Foot').z - at(start, 'Foot', support).z).toBeGreaterThan(.5);
        expect(Math.abs(at(start, 'Foot').x - at(start, 'Foot', support).x)).toBeLessThan(.03);
        expect(Math.abs(at(start, 'Foot').y - at(start, 'Foot', support).y)).toBeLessThan(.025);
        expect(point(start, 'Hips').y - point(assessed, 'Hips').y).toBeGreaterThan(.3);
        for (const which of ['L', 'R'] as const) expect(at(assessed, 'Foot', which).distanceTo(at(start, 'Foot', which))).toBeLessThan(.025);
        expect(at(assessed, 'Leg', support).y).toBeLessThan(.25);
      } else if (id === 'rotary-stability') {
        const lift = result.phases[1]!;
        expect(at(lift, 'Hand').y - at(start, 'Hand').y).toBeGreaterThan(.4);
        expect(at(lift, 'Foot').y - at(start, 'Foot').y).toBeGreaterThan(.35);
        expect(at(lift, 'Leg', support).y).toBeLessThan(.06);
        expect(Math.abs(at(lift, 'Hand', support).y)).toBeLessThan(.06);
        const extendedGap = at(lift, 'Forearm').distanceTo(at(lift, 'Leg'));
        expect(at(assessed, 'Forearm').distanceTo(at(assessed, 'Leg'))).toBeLessThan(extendedGap * .4);
        expect(at(assessed, 'Forearm').distanceTo(at(assessed, 'Leg'))).toBeLessThan(.4);
      } else if (id === 'trunk-stability-push-up' || id === 'extension-clearing') {
        expect(point(start, 'Hips').y).toBeLessThan(.2);
        for (const phase of [start, assessed, finish]) for (const which of ['L', 'R'] as const) expect(Math.abs(at(phase, 'Hand', which).y)).toBeLessThan(.065);
        expect(point(assessed, 'Head').y - point(start, 'Head').y).toBeGreaterThan(.25);
        if (id === 'extension-clearing') {
          expect(point(assessed, 'Hips').distanceTo(point(start, 'Hips'))).toBeLessThan(.005);
        } else {
          expect(point(assessed, 'Hips').y - point(start, 'Hips').y).toBeGreaterThan(.2);
          expect(at(assessed, 'Leg').y - at(start, 'Leg').y).toBeGreaterThan(.08);
          expect(point(assessed, 'Head').distanceTo(point(assessed, 'Hips'))).toBeCloseTo(point(start, 'Head').distanceTo(point(start, 'Hips')), 2);
        }
      } else if (id === 'flexion-clearing') {
        expect(point(start, 'Hips').y - point(assessed, 'Hips').y).toBeGreaterThan(.14);
        expect(at(assessed, 'Leg').z - point(assessed, 'Hips').z).toBeGreaterThan(.3);
        for (const which of ['L', 'R'] as const) {
          expect(Math.abs(at(assessed, 'Hand', which).y)).toBeLessThan(.05);
          expect(at(assessed, 'Forearm', which).y).toBeGreaterThan(.04);
          expect(Math.abs(at(assessed, 'Foot', which).y)).toBeLessThan(.08);
        }
      } else if (id === 'multisegmental-flexion') {
        expect(at(start, 'Hand').y - at(assessed, 'Hand').y).toBeGreaterThan(.7);
        expect(at(assessed, 'Hand').y).toBeLessThan(.25);
        expect(point(assessed, 'Head').y).toBeLessThan(point(assessed, 'Hips').y);
        for (const which of ['L', 'R'] as const) {
          const thigh = at(assessed, 'UpLeg', which).sub(at(assessed, 'Leg', which));
          const shin = at(assessed, 'Foot', which).sub(at(assessed, 'Leg', which));
          expect(THREE.MathUtils.radToDeg(thigh.angleTo(shin))).toBeGreaterThan(165);
        }
      } else if (id === 'multisegmental-extension') {
        expect(at(start, 'Hand').y - point(start, 'Head').y).toBeGreaterThan(.4);
        expect(point(assessed, 'Head').z - point(assessed, 'Hips').z).toBeLessThan(-.3);
        expect(at(assessed, 'Hand').y - point(assessed, 'Head').y).toBeGreaterThan(.2);
        expect(point(assessed, 'Hips').z - at(assessed, 'Foot').z).toBeGreaterThan(.1);
      } else if (id === 'multisegmental-rotation') {
        const yaw = (left: string, right: string) => {
          const width = point(assessed, left).sub(point(assessed, right));
          return THREE.MathUtils.radToDeg(Math.atan2(-width.z, width.x));
        };
        const pelvisYaw = yaw('L_UpLeg', 'R_UpLeg'), trunkYaw = yaw('L_Forearm', 'R_Forearm');
        expect(pelvisYaw * (side === 'L' ? 1 : -1)).toBeGreaterThan(25);
        expect(Math.abs(trunkYaw)).toBeGreaterThan(Math.abs(pelvisYaw) + 20);
        for (const which of ['L', 'R'] as const) expect(at(assessed, 'Foot', which).distanceTo(at(start, 'Foot', which))).toBeLessThan(.025);
      } else if (id === 'single-leg-stance') {
        expect(Math.abs(at(assessed, 'Leg').y - point(assessed, 'Hips').y)).toBeLessThan(.05);
        expect(at(assessed, 'Foot').y - at(start, 'Foot').y).toBeGreaterThan(.4);
        expect(at(assessed, 'Foot', support).distanceTo(at(start, 'Foot', support))).toBeLessThan(.025);
        expect(longestHold).toBe(10000);
      } else if (id === 'sfma-overhead-deep-squat-legacy') {
        expect(point(start, 'Hips').y - point(assessed, 'Hips').y).toBeGreaterThan(.6);
        expect(point(assessed, 'Hips').y).toBeLessThan(at(assessed, 'Leg').y - .03);
        for (const phase of result.phases.slice(7)) {
          expect(at(phase, 'Hand').y - point(phase, 'Head').y).toBeGreaterThan(.35);
          const torso = point(phase, 'Head').sub(point(phase, 'Hips'));
          expect(THREE.MathUtils.radToDeg(torso.angleTo(new THREE.Vector3(0, 1, 0)))).toBeLessThan(40);
          const skin = footSkin(phase);
          expect(skin.gap).toBeGreaterThan(.25);
          expect(skin.gap).toBeLessThan(.42);
          for (const height of skin.minY) expect(Math.abs(height)).toBeLessThan(.006);
          for (const which of ['R', 'L'] as const) expect(at(phase, 'Foot', which).distanceTo(at(start, 'Foot', which))).toBeLessThan(.04);
        }
      }
    });

    // Held, the pattern stops in its assessed position (movementScreen's hold mode). The single-leg stance re-plants
    // its lifted foot after the lowering, which a held motion never plays: the foot must stay up to the end. Held for
    // an authored 20 s, which the resolver plays as 10 s, the re-plant came 12.4 s in and put the foot back down.
    it.each(['R', 'L'] as const)('holds the single-leg stance with the knee raised to the end / %s', side => {
      const { recording } = sample(movementScreenMotion(movementScreenPattern('sfma-repo-legacy-v1/single-leg-stance/top-tier')!, side, 'hold')!);
      const raised = recording.frames.filter(frame => frame.tMs >= 6800);
      expect(raised.length).toBeGreaterThan(90);
      const start = point(recording.frames[0]!, `${side}_Foot`).y;
      for (const frame of raised) expect(point(frame, `${side}_Foot`).y - start, `${frame.tMs} ms`).toBeGreaterThan(.4);
    });
  });
}
