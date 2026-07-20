/**
 * NATURAL SPINAL GAIT COORDINATION — the trunk must counter-rotate with the arm
 * swing and sway toward the stance leg, so gait reads as human instead of a rigid
 * torso on moving legs. This pins: (1) the transform ADDS only spine/neck targets
 * and leaves every leg/arm driver byte-identical (feet + goniometry untouched);
 * (2) the thoracic axial rotation OSCILLATES across the cycle (both directions);
 * (3) it is DERIVED from the arm swing, so a damped arm swing damps the trunk
 * rotation; (4) identity at zero gain; and (5) on the sampled rig the measured
 * thoracic rotation actually swings through a believable range.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose, buildBoneByPoseKey, applyCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import {
  buildRun,
  buildTravelWalk,
  spinalGaitCoordination,
  templateToComposedMotion,
  scaleArmSwing,
  MOVEMENT_TEMPLATES,
} from '../services/movementTemplates';
import { measureCommandMotion } from '../services/movementCommand';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const SPINE_MOTIONS = new Set(['rotation', 'lateralTilt']);
/** A joint/motion the gait coordinator is allowed to author: spine/neck rotation +
 *  lateral tilt (thorax counter-rotation, lean, gaze), the hip counter-rotation that holds
 *  the feet forward as the pelvis rotates, and the SUBTLE limb non-sagittal set (shoulder
 *  abduction, forearm rotation, hip abduction, knee rotation, ankle inversion) that keeps
 *  the arms/legs from swinging as flat 2-D pendulums. */
const LIMB_NONSAG: Record<string, string> = {
  L_Shoulder: 'protraction', R_Shoulder: 'protraction',
  L_UpperArm: 'shoulderAbduction', R_UpperArm: 'shoulderAbduction',
  L_Forearm: 'forearmRotation', R_Forearm: 'forearmRotation',
  L_UpLeg: 'hipRotation|hipAbduction', R_UpLeg: 'hipRotation|hipAbduction',
  L_Leg: 'kneeRotation', R_Leg: 'kneeRotation',
  L_Foot: 'ankleInversion', R_Foot: 'ankleInversion',
};
const isCoordinationAdd = (joint: string, motion: string) =>
  ((joint === 'Spine_Upper' || joint === 'Spine_Lower' || joint === 'Neck') && SPINE_MOTIONS.has(motion)) ||
  (LIMB_NONSAG[joint]?.split('|').includes(motion) ?? false);

const walkComposed = () =>
  templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);

/** The peak-to-peak swing of Spine_Upper axial rotation across a motion's keyframes. */
const thoracicSwing = (m: ReturnType<typeof buildRun>): number => {
  const vals = m.keyframes.map(
    (kf) => kf.targets?.find((t) => t.joint === 'Spine_Upper' && t.motion === 'rotation')?.targetDegrees ?? 0,
  );
  return Math.max(...vals) - Math.min(...vals);
};

describe('spinalGaitCoordination — trunk counter-rotation authoring', () => {
  it('is identity when the gains are 0 (clean/opt-out)', () => {
    const base = walkComposed();
    expect(spinalGaitCoordination(base, { axial: 0, lateral: 0, pelvis: 0 })).toBe(base);
  });

  it('ADDS only coordination targets — every arm/sagittal-leg driver is byte-identical', () => {
    const base = walkComposed();
    const out = spinalGaitCoordination(base);
    expect(out.keyframes.length).toBe(base.keyframes.length);
    for (let i = 0; i < base.keyframes.length; i += 1) {
      const before = base.keyframes[i]!.targets ?? [];
      const after = out.keyframes[i]!.targets ?? [];
      // Nothing removed or mutated among the ORIGINAL targets…
      for (const b of before) {
        const match = after.find((t) => t.joint === b.joint && t.motion === b.motion);
        expect(match, `${b.joint}.${b.motion} preserved`).toBeDefined();
        // A pre-existing spine lateralTilt/rotation may be added onto; everything the
        // coordinator doesn't own (the sagittal leg drive, arm swing) must be untouched.
        if (!isCoordinationAdd(b.joint, b.motion)) {
          expect(match!.targetDegrees, `${b.joint}.${b.motion} unchanged`).toBe(b.targetDegrees);
        }
      }
      // …and every NEW target is a coordination add (spine/neck rotation·tilt or hip counter).
      for (const a of after) {
        const wasThere = before.some((t) => t.joint === a.joint && t.motion === a.motion);
        if (!wasThere) expect(isCoordinationAdd(a.joint, a.motion), `${a.joint}.${a.motion} is a coordination add`).toBe(true);
      }
    }
  });

  it('adds SUBTLE non-sagittal LIMB motion — arms/legs move in all 3 planes, not flat pendulums', () => {
    const out = spinalGaitCoordination(walkComposed());
    const present = (joint: string, motion: string) =>
      out.keyframes.some((kf) => kf.targets?.some((t) => t.joint === joint && t.motion === motion && Math.abs(t.targetDegrees) > 0.5));
    const maxAbs = (joint: string, motion: string) =>
      Math.max(...out.keyframes.map((kf) => Math.abs(kf.targets?.find((t) => t.joint === joint && t.motion === motion)?.targetDegrees ?? 0)));
    // Arms: hang IN close to the body — a slight ADduction (frontal) + forearm pronation.
    expect(present('R_UpperArm', 'shoulderAbduction'), 'arm frontal motion').toBe(true);
    expect(present('R_Forearm', 'forearmRotation'), 'forearm rotation').toBe(true);
    // Shoulder GIRDLE: the scapula protracts/retracts fore/aft WITH the arm swing — arm
    // swing isn't purely glenohumeral. It must OSCILLATE (protract on the forward swing,
    // retract on the backswing), not sit at a fixed offset.
    expect(present('R_Shoulder', 'protraction'), 'scapular protraction/retraction').toBe(true);
    const scapVals = out.keyframes.map(
      (kf) => kf.targets?.find((t) => t.joint === 'R_Shoulder' && t.motion === 'protraction')?.targetDegrees ?? 0,
    );
    expect(Math.max(...scapVals), 'scapula protracts on the forward swing').toBeGreaterThan(0.5);
    expect(Math.min(...scapVals), 'scapula retracts on the backswing').toBeLessThan(-0.5);
    expect(Math.max(...scapVals.map(Math.abs)), 'scapular glide stays subtle').toBeLessThanOrEqual(10);
    // Legs: swing hip ADduction (frontal), tibial rotation (transverse), subtalar roll (frontal).
    expect(present('R_UpLeg', 'hipAbduction'), 'hip frontal motion').toBe(true);
    expect(present('R_Leg', 'kneeRotation'), 'knee rotation').toBe(true);
    expect(present('R_Foot', 'ankleInversion'), 'ankle inversion').toBe(true);
    // The legs ADduct toward the midline (a narrow base) — NOT abduct (a wide waddle). The
    // hip frontal target must be NEGATIVE (adduction) at its extreme.
    const signedExtreme = (joint: string, motion: string) => {
      let ext = 0;
      for (const kf of out.keyframes) for (const t of kf.targets ?? [])
        if (t.joint === joint && t.motion === motion && Math.abs(t.targetDegrees) > Math.abs(ext)) ext = t.targetDegrees;
      return ext;
    };
    expect(signedExtreme('R_UpLeg', 'hipAbduction'), 'legs ADduct toward the midline, not abduct').toBeLessThan(0);
    // The arms hang IN close to the body — the shoulder frontal target is NEGATIVE
    // (adduction), not winged out (abduction).
    expect(signedExtreme('R_UpperArm', 'shoulderAbduction'), 'arms ADduct in, not winged out').toBeLessThan(0);
    // …all SUBTLE — physiologic, well inside ROM, never exaggerated.
    expect(maxAbs('R_UpperArm', 'shoulderAbduction'), 'arm adduction stays subtle').toBeLessThan(16);
    expect(maxAbs('R_UpLeg', 'hipAbduction'), 'hip adduction stays subtle').toBeLessThan(8);
    expect(maxAbs('R_Foot', 'ankleInversion'), 'ankle roll stays subtle').toBeLessThan(10);
  });

  it('thoracic axial rotation OSCILLATES — both directions within one cycle', () => {
    const rot = spinalGaitCoordination(walkComposed()).keyframes.map(
      (kf) => kf.targets?.find((t) => t.joint === 'Spine_Upper' && t.motion === 'rotation')?.targetDegrees ?? 0,
    );
    expect(Math.max(...rot), 'rotates one way').toBeGreaterThan(2);
    expect(Math.min(...rot), 'and the other').toBeLessThan(-2);
  });

  it('is DERIVED from the arm swing — a damped arm swing damps the trunk rotation', () => {
    const full = spinalGaitCoordination(walkComposed());
    const damped = spinalGaitCoordination(scaleArmSwing(walkComposed(), 0.25));
    expect(thoracicSwing(damped)).toBeLessThan(thoracicSwing(full) * 0.5);
  });

  it('the run and travel-walk builders ship with trunk coordination baked in', () => {
    expect(thoracicSwing(buildRun()), 'run counter-rotates').toBeGreaterThan(6);
    expect(thoracicSwing(buildTravelWalk()), 'travel walk counter-rotates').toBeGreaterThan(4);
  });

  it('stays within physiologic ROM (never near end-range)', () => {
    for (const m of [buildRun(), buildRun({ speed: 1.6 }), buildTravelWalk()]) {
      for (const kf of m.keyframes) {
        for (const t of kf.targets ?? []) {
          if (t.joint === 'Spine_Upper' && t.motion === 'rotation') expect(Math.abs(t.targetDegrees)).toBeLessThanOrEqual(14);
          if (t.joint === 'Spine_Lower' && t.motion === 'rotation') expect(Math.abs(t.targetDegrees)).toBeLessThanOrEqual(8);
          if (t.motion === 'lateralTilt') expect(Math.abs(t.targetDegrees)).toBeLessThanOrEqual(8);
        }
      }
    }
  });
});

describe('spinalGaitCoordination — measured on the rig', () => {
  const variantCfg = BODY_VARIANTS.male;
  const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
  let root: THREE.Object3D;
  let skinned: THREE.SkinnedMesh;
  let rest: JointAngleRestReference;
  let baselinePose: CustomPose;

  beforeAll(async () => {
    const buf = readFileSync(fileURLToPath(GLB_URL));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
      const l = new GLTFLoader();
      l.setMeshoptDecoder(MeshoptDecoder);
      l.parse(ab, '', res as never, rej);
    });
    root = gltf.scene;
    root.scale.setScalar(variantCfg.pose.rootScale);
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
    });
    root.updateMatrixWorld(true);
    applyAnatomicPose(root, variantCfg);
    root.updateMatrixWorld(true);
    rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
    baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  });

  it('the sampled run shows a real thoracic counter-rotation while the legs keep working', () => {
    const rec = sampleComposedMotion(resolveComposedMotion(buildRun(), variantCfg), {
      baselinePose,
      variantCfg,
      rest,
      skeletonHarness: { root, skinned },
      sampleHz: 60,
    });
    const rot = rec.frames.map(
      (f) => measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'Spine_Upper', 'rotation') ?? 0,
    );
    const hip = rec.frames.map(
      (f) => measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'R_UpLeg', 'hipFlexion') ?? 0,
    );
    const rotRange = Math.max(...rot) - Math.min(...rot);
    const hipRange = Math.max(...hip) - Math.min(...hip);
    // eslint-disable-next-line no-console
    console.log(`run rig: thoracic rotation range ${rotRange.toFixed(1)}°, hip flexion range ${hipRange.toFixed(1)}°`);
    expect(rotRange, 'the trunk visibly counter-rotates').toBeGreaterThan(6);
    expect(Math.max(...rot), 'toward one side').toBeGreaterThan(1);
    expect(Math.min(...rot), 'and the other').toBeLessThan(-1);
    expect(hipRange, 'the legs are still driving the stride').toBeGreaterThan(30);
  });

  it('PELVIS rotates and counter-rotates the thorax, while the GAZE stays forward', () => {
    // Measure WORLD orientation: apply the per-frame ROOT yaw (the pelvic rotation) to the
    // scene root, then the pose. Yaw of each segment's forward (+Z) vector (no Euler gimbal).
    const fwdYaw = (b: THREE.Bone): number => {
      const q = new THREE.Quaternion(); b.getWorldQuaternion(q);
      const v = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      return (Math.atan2(v.x, v.z) * 180) / Math.PI;
    };
    for (const motion of [buildTravelWalk(), buildRun()]) {
      const rec = sampleComposedMotion(resolveComposedMotion(motion, variantCfg), {
        baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30,
      });
      const bones = buildBoneByPoseKey(skinned.skeleton, variantCfg);
      const head = bones.get('Head')!, thorax = bones.get('Spine_Upper')!, pelvis = bones.get('Hips')!;
      let hMin = Infinity, hMax = -Infinity, pMin = Infinity, pMax = -Infinity, tMin = Infinity, tMax = -Infinity;
      const pelSeries: number[] = [], thoSeries: number[] = [];
      for (const f of rec.frames) {
        const rq = f.root.orientQuat; root.quaternion.set(rq[0], rq[1], rq[2], rq[3]);
        applyCustomPose(skinned.skeleton, variantCfg, f.pose);
        root.updateMatrixWorld(true);
        const hy = fwdYaw(head), py = fwdYaw(pelvis), ty = fwdYaw(thorax);
        hMin = Math.min(hMin, hy); hMax = Math.max(hMax, hy);
        pMin = Math.min(pMin, py); pMax = Math.max(pMax, py);
        tMin = Math.min(tMin, ty); tMax = Math.max(tMax, ty);
        pelSeries.push(py); thoSeries.push(ty);
      }
      const headSwing = hMax - hMin, pelvisSwing = pMax - pMin, thoraxSwing = tMax - tMin;
      // Pelvis vs thorax counter-rotation: negative covariance = opposite phase (the real
      // transverse engine of gait — the shoulder girdle winds against the pelvis).
      const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
      const mp = mean(pelSeries), mt = mean(thoSeries);
      let cov = 0; for (let i = 0; i < pelSeries.length; i += 1) cov += (pelSeries[i]! - mp) * (thoSeries[i]! - mt);
      // eslint-disable-next-line no-console
      console.log(`${motion.name}: PELVIS yaw ${pelvisSwing.toFixed(1)}° · THORAX ${thoraxSwing.toFixed(1)}° · HEAD ${headSwing.toFixed(1)}° · phase ${cov < 0 ? 'OPPOSITE' : 'same'}`);
      expect(pelvisSwing, 'the pelvis visibly rotates (the determinant of gait)').toBeGreaterThan(3.5);
      expect(thoraxSwing, 'the thorax rotates too (shoulder girdle)').toBeGreaterThan(7);
      expect(cov, 'the pelvis and thorax COUNTER-rotate').toBeLessThan(0);
      // The whole trunk turns beneath it, but the head/gaze holds forward — the neck now
      // cancels the pelvic root yaw as well as the spine rotation (vestibulo-ocular).
      expect(headSwing, 'the gaze stays forward despite the pelvic rotation').toBeLessThan(6);
    }
  });

  it('gait reads as ROTATION, not a waddle — the trunk rotates far more than it leans laterally', () => {
    // World thorax yaw (transverse ROTATION, the arm-swing counter-rotation) must dominate
    // world thorax roll (frontal LATERAL lean). A hot lateral-sway gain used to lurch the
    // trunk ~13° side-to-side; real gait keeps the trunk near-vertical in the frontal plane
    // and the rotation is the visible character.
    const axis = (b: THREE.Bone, idx: 1 | 2): number => {
      const q = new THREE.Quaternion(); b.getWorldQuaternion(q);
      const e = new THREE.Euler().setFromQuaternion(q, 'YZX');
      return ((idx === 1 ? e.y : e.z) * 180) / Math.PI;
    };
    for (const motion of [buildTravelWalk(), buildRun()]) {
      const rec = sampleComposedMotion(resolveComposedMotion(motion, variantCfg), {
        baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
      });
      const thorax = buildBoneByPoseKey(skinned.skeleton, variantCfg).get('Spine_Upper')!;
      let yMin = Infinity, yMax = -Infinity, rMin = Infinity, rMax = -Infinity;
      for (const f of rec.frames) {
        applyCustomPose(skinned.skeleton, variantCfg, f.pose); root.updateMatrixWorld(true);
        const y = axis(thorax, 1), r = axis(thorax, 2);
        yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
        rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
      }
      const rot = yMax - yMin, lat = rMax - rMin;
      // eslint-disable-next-line no-console
      console.log(`${motion.name}: thorax ROTATION ${rot.toFixed(1)}° vs LATERAL lean ${lat.toFixed(1)}°`);
      expect(lat, `${motion.name}: lateral trunk lean stays small (not a waddle)`).toBeLessThan(8);
      expect(rot, `${motion.name}: rotation dominates the lateral lean`).toBeGreaterThan(lat * 1.8);
    }
  });

  it('scapular girdle GLIDES fore/aft on the rig — the shoulder protracts/retracts with the swing', () => {
    // Isolate the girdle glide from trunk rotation + root motion: express the R shoulder
    // joint (R_UpperArm origin) IN THE THORAX FRAME. On the path Spine_Upper → R_Shoulder
    // (clavicle) → R_UpperArm, only the clavicle articulates — arm swing rotates the humerus
    // ABOUT that origin and cannot move it. So a thorax-relative excursion of the joint is a
    // pure scapular protraction/retraction readout: a real, visible fore/aft girdle glide.
    const rec = sampleComposedMotion(resolveComposedMotion(buildTravelWalk(), variantCfg), {
      baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
    });
    const bones = buildBoneByPoseKey(skinned.skeleton, variantCfg);
    const shoulder = bones.get('R_UpperArm')!, thorax = bones.get('Spine_Upper')!;
    const tPos = new THREE.Vector3(), sPos = new THREE.Vector3(), tQ = new THREE.Quaternion();
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (const f of rec.frames) {
      applyCustomPose(skinned.skeleton, variantCfg, f.pose); root.updateMatrixWorld(true);
      thorax.getWorldPosition(tPos); thorax.getWorldQuaternion(tQ); shoulder.getWorldPosition(sPos);
      const rel = sPos.clone().sub(tPos).applyQuaternion(tQ.clone().invert());
      xs.push(rel.x); ys.push(rel.y); zs.push(rel.z);
    }
    const range = (a: number[]) => Math.max(...a) - Math.min(...a);
    const glideCm = Math.max(range(xs), range(ys), range(zs)) * 100;
    // eslint-disable-next-line no-console
    console.log(`walk-forward: scapular fore/aft glide ${glideCm.toFixed(1)} cm`);
    expect(glideCm, 'the shoulder girdle visibly glides on the ribcage (protraction/retraction)').toBeGreaterThan(0.8);
    expect(glideCm, 'but stays subtle — a physiologic glide, not a shrug').toBeLessThan(15);
  });

  it('the HEAD stays steady in gait — minimal lateral bob AND roll (vestibular stabilization)', () => {
    // A person's head barely moves side-to-side when walking: it's the most stabilised
    // segment. Two mechanisms, both authored in spinalGaitCoordination: the thoracic
    // COUNTER-lists (an S-curve over the lumbar sway) to keep the shoulders/head centred
    // — so the head TRANSLATES little; and the neck lateral counter cancels the roll the
    // large axial neck counter would otherwise leak — so the head ROLLS little.
    const rec = sampleComposedMotion(resolveComposedMotion(buildTravelWalk(), variantCfg), {
      baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
    });
    const head = buildBoneByPoseKey(skinned.skeleton, variantCfg).get('Head')!;
    const pos = new THREE.Vector3(); const q = new THREE.Quaternion();
    let xMin = Infinity, xMax = -Infinity, rMin = Infinity, rMax = -Infinity;
    for (const f of rec.frames) {
      const rq = f.root.orientQuat; root.quaternion.set(rq[0], rq[1], rq[2], rq[3]);
      const tr = f.root.translateM; root.position.set(tr[0], tr[1], tr[2]);
      applyCustomPose(skinned.skeleton, variantCfg, f.pose); root.updateMatrixWorld(true);
      head.getWorldPosition(pos);
      head.getWorldQuaternion(q);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q); // true roll, no Euler cross-talk
      const roll = (Math.atan2(up.x, up.y) * 180) / Math.PI;
      xMin = Math.min(xMin, pos.x); xMax = Math.max(xMax, pos.x);
      rMin = Math.min(rMin, roll); rMax = Math.max(rMax, roll);
    }
    const lateralCm = (xMax - xMin) * 100;
    const rollDeg = rMax - rMin;
    // eslint-disable-next-line no-console
    console.log(`walk-forward: HEAD lateral ${lateralCm.toFixed(1)}cm · roll ${rollDeg.toFixed(1)}°`);
    expect(lateralCm, 'head barely translates side to side').toBeLessThan(2.5);
    expect(rollDeg, 'head barely rolls side to side').toBeLessThan(2.5);
  });

  it('UNIVERSAL gaze: a NON-GAIT trunk rotation also holds the eyes forward (automatic)', () => {
    const yaw = (b: THREE.Bone): number => {
      const q = new THREE.Quaternion();
      b.getWorldQuaternion(q);
      return (new THREE.Euler().setFromQuaternion(q, 'YXZ').y * 180) / Math.PI;
    };
    // A plain upright trunk twist — no gait, no arm swing, no neck authored. stabilizeGaze
    // (automatic in resolveComposedMotion) should keep the head world-forward while the
    // thorax rotates. (16 thoracic + 6 lumbar = 22°, within the 24° cervical counter cap.)
    const twist: ComposedMotion = {
      name: 'trunk rotation',
      keyframes: [
        { targets: [
          { joint: 'Spine_Upper', motion: 'rotation', targetDegrees: 16 },
          { joint: 'Spine_Lower', motion: 'rotation', targetDegrees: 6 },
        ], durationMs: 900, holdMs: 200 },
        { targets: [
          { joint: 'Spine_Upper', motion: 'rotation', targetDegrees: 0 },
          { joint: 'Spine_Lower', motion: 'rotation', targetDegrees: 0 },
        ], durationMs: 900 },
      ],
    };
    const rec = sampleComposedMotion(resolveComposedMotion(twist, variantCfg), {
      baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30,
    });
    const bones = buildBoneByPoseKey(skinned.skeleton, variantCfg);
    const head = bones.get('Head')!, thorax = bones.get('Spine_Upper')!;
    let hMin = Infinity, hMax = -Infinity, tMin = Infinity, tMax = -Infinity;
    for (const f of rec.frames) {
      applyCustomPose(skinned.skeleton, variantCfg, f.pose);
      root.updateMatrixWorld(true);
      const hy = yaw(head), ty = yaw(thorax);
      hMin = Math.min(hMin, hy); hMax = Math.max(hMax, hy);
      tMin = Math.min(tMin, ty); tMax = Math.max(tMax, ty);
    }
    const headSwing = hMax - hMin, thoraxSwing = tMax - tMin;
    // eslint-disable-next-line no-console
    console.log(`non-gait trunk rotation: HEAD yaw swing ${headSwing.toFixed(1)}° vs THORAX ${thoraxSwing.toFixed(1)}°`);
    expect(thoraxSwing, 'the trunk visibly rotates').toBeGreaterThan(15);
    expect(headSwing, 'the head/gaze stays forward — not riding the spine').toBeLessThan(7);
    expect(headSwing).toBeLessThan(thoraxSwing * 0.4);
  });
});
