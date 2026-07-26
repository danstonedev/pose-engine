/**
 * HAND CARRIAGE THROUGH THE ARM SWING — measured on the rig.
 *
 * WHY THIS EXISTS. Reported against the deployed build: "the arms don't look
 * relaxed from the side of the model because the hands are always sorta tilted
 * forward", and separately that the wrist showed no meaningful radial/ulnar
 * deviation. Both were real, both were invisible to the suite, and both came from
 * the same class of mistake — a CONSTANT offset applied to a channel that should
 * oscillate, and a channel left undriven entirely:
 *
 *   • `WRIST_FLEX_BASE` was +10°, applied every frame. With the arm at the side,
 *     wrist flexion carries the hand ANTERIORLY, so the hand sat permanently
 *     tipped forward — rig-measured 19.9° forward of vertical against the 9.5°
 *     the rig's own rest already has. The wrist never reached neutral, let alone
 *     extension.
 *   • `wristDeviation` measured EXACTLY 0.000° on every frame — the gait
 *     coordinator never drove it, so the hand had no frontal-plane life at all.
 *   • `ARM_PRO_BASE` was +12°, and + is SUPINATION (romRegistry / movementCommand,
 *     rig-tested), so the palm was rotated AWAY from the thigh toward facing
 *     forward — the opposite of that constant's own stated intent.
 *
 * A joint-angle readout alone would not have caught the first or third: the
 * numbers were non-zero and inside ROM, they were just pointed the wrong way or
 * offset. So this gate measures the hand's actual ORIENTATION IN WORLD SPACE off
 * the finger bones, which is what a viewer sees, and pins the excursions of all
 * three channels so a "texture" constant cannot quietly decay to invisible again.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { buildTravelWalk } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

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

interface Carriage {
  /**
   * Wrist bend measured RELATIVE TO THE FOREARM, signed about the hand's own
   * medio-lateral axis. This is a GEOMETRIC sign taken from the bone axes, and it
   * runs OPPOSITE to the registry's `wristFlexion`: adding +10° of registry
   * flexion drives this value from −4.8° to −14.4°, so here more-negative means
   * more-flexed. It is a magnitude check on how far the hand is held off the
   * forearm, not a substitute for the clinical readout — the direction assertions
   * live on the measured `wristFlexion` series in the next test.
   *
   * It must be forearm-relative. Measuring the hand's tilt against WORLD vertical
   * conflates the wrist with the shoulder — at mid-swing the whole arm is ~18°
   * forward, so a perfectly straight wrist reads as 38° "tilted forward". That
   * mistake is why the first version of this gate failed on correct output.
   */
  wristBendDeg: number;
  /** Palm normal, world. +X is subject-left = MEDIAL for the right hand. */
  palm: THREE.Vector3;
}

/** Measure the right hand's carriage from its own bone geometry. */
function measureCarriage(): Carriage | null {
  root.updateMatrixWorld(true);
  const map = buildBoneByPoseKey(skinned.skeleton, variantCfg);
  const hand = map.get('R_Hand');
  const mid = map.get('R_Mid1');
  const index = map.get('R_Index1');
  const pinky = map.get('R_Pinky1');
  const forearm = map.get('R_Forearm');
  if (!hand || !mid || !index || !pinky || !forearm) return null;
  const at = (b: THREE.Bone) => b.getWorldPosition(new THREE.Vector3());
  const handAxis = at(mid).sub(at(hand)).normalize(); // hand, pointing distally
  const foreAxis = at(hand).sub(at(forearm)).normalize(); // forearm, pointing distally
  const mlAxis = at(pinky).sub(at(index)).normalize(); // the flexion hinge axis
  const palm = new THREE.Vector3().crossVectors(handAxis, mlAxis).normalize();
  // Signed rotation of the hand off the forearm ABOUT the hand's ML axis.
  const cross = new THREE.Vector3().crossVectors(foreAxis, handAxis);
  const wristBendDeg =
    (Math.atan2(cross.dot(mlAxis), foreAxis.dot(handAxis)) * 180) / Math.PI;
  return { wristBendDeg, palm };
}

describe('the walking hand hangs relaxed rather than held forward', () => {
  it('does not sit tilted forward of the rig’s own resting hang', () => {
    applyAnatomicPose(root, variantCfg);
    const atRest = measureCarriage();
    expect(atRest, 'the finger bones resolve through the bone map').not.toBeNull();

    const resolved = resolveComposedMotion(buildTravelWalk(), variantCfg);
    const rec = sampleComposedMotion(resolved, {
      baselinePose,
      variantCfg,
      rest,
      skeletonHarness: { root, skinned },
      sampleHz: 120,
    });
    // Mid-cycle, clear of the entry and the braking step.
    const frame = rec.frames.reduce((b, f) =>
      Math.abs(f.tMs - 1100) < Math.abs(b.tMs - 1100) ? f : b,
    );
    // Re-seat from the anatomic baseline first: a pose application lands against
    // the current skeleton state, and `sampleComposedMotion` documents that it
    // LEAVES THE HARNESS AT THE FINAL FRAME — so without this reset (and without
    // applying to `skinned.skeleton`, not `root`) this reads the settle pose back
    // and silently reports the wrong instant.
    applyAnatomicPose(root, variantCfg);
    applyCustomPose(
      skinned.skeleton,
      variantCfg,
      JSON.parse(JSON.stringify(frame.pose)) as CustomPose,
    );
    const walking = measureCarriage();
    expect(walking).not.toBeNull();

    // eslint-disable-next-line no-console
    console.log(
      `wrist bend off the forearm: rest ${atRest!.wristBendDeg.toFixed(1)}° → walking ` +
        `${walking!.wristBendDeg.toFixed(1)}° · palm·medial ${walking!.palm.x.toFixed(2)} ` +
        `(rest ${atRest!.palm.x.toFixed(2)})`,
    );

    // THE REPORTED DEFECT: the walk must not hold the hand bent off the forearm.
    // The old +10° base did exactly that on every frame (this metric read −14.4°
    // against a −7.8° rest); the drag now oscillates about the rig's own hang, so
    // at any instant the wrist sits within the swing's own excursion of rest
    // rather than a constant beyond it. The sharper catch on that specific
    // regression is `reaches extension` in the next test — this bounds the
    // magnitude, that pins the direction.
    expect(Math.abs(walking!.wristBendDeg - atRest!.wristBendDeg)).toBeLessThan(10);

    // THE PALM STAYS ON THE THIGH. + X is medial for the right hand; the forearm
    // base must not rotate the palm out toward facing forward (which is what a
    // POSITIVE forearmRotation — supination — did).
    expect(walking!.palm.x, 'palm faces medially, toward the thigh').toBeGreaterThan(
      atRest!.palm.x - 0.05,
    );
  });

  it('all three wrist/forearm channels carry visible excursion, and flexion crosses neutral', () => {
    const resolved = resolveComposedMotion(buildTravelWalk(), variantCfg);
    const rec = sampleComposedMotion(resolved, {
      baselinePose,
      variantCfg,
      rest,
      skeletonHarness: { root, skinned },
      sampleHz: 120,
    });
    const ends: number[] = [];
    let acc = 0;
    for (const k of resolved.keyframes) {
      acc += k.durationMs + (k.holdMs ?? 0);
      ends.push(acc);
    }
    const series = (joint: string, motion: string): number[] =>
      rec.frames
        .filter((f) => f.tMs >= ends[2]! && f.tMs <= ends[8]!)
        .map((f) => (f.angles as Record<string, Record<string, number>> | undefined)?.[joint]?.[motion])
        .filter((v): v is number => typeof v === 'number');

    const excursion = (v: number[]) => Math.max(...v) - Math.min(...v);
    const flex = series('R_Hand', 'wristFlexion');
    const dev = series('R_Hand', 'wristDeviation');
    const pro = series('R_Forearm', 'forearmRotation');
    expect(flex.length, 'the wrist is measured at all').toBeGreaterThan(10);

    // eslint-disable-next-line no-console
    console.log(
      `excursions — wristFlexion ${excursion(flex).toFixed(1)}° ` +
        `[${Math.min(...flex).toFixed(1)}, ${Math.max(...flex).toFixed(1)}] · ` +
        `wristDeviation ${excursion(dev).toFixed(1)}° · forearmRotation ${excursion(pro).toFixed(1)}°`,
    );

    // Each channel must actually move. `wristDeviation` shipped at a flat 0.000°
    // and then at a 6.9° sweep that still read as nothing on screen, so the floor
    // is set above "technically non-zero".
    expect(excursion(flex), 'wrist flexion/extension').toBeGreaterThan(5);
    expect(excursion(dev), 'wrist radial/ulnar deviation').toBeGreaterThan(5);
    expect(excursion(pro), 'forearm pronation/supination').toBeGreaterThan(5);

    // …and the flexion OSCILLATES rather than riding a constant offset: a relaxed
    // wrist passes through neutral into slight extension each cycle. This is the
    // assertion the old +10° base would have failed.
    expect(Math.min(...flex), 'reaches extension').toBeLessThan(0);
    expect(Math.max(...flex), 'reaches flexion').toBeGreaterThan(0);

    // The hand hangs ULNAR-biased, as a relaxed hand does (− is ulnar).
    expect(dev.reduce((a, b) => a + b, 0) / dev.length, 'mean deviation is ulnar').toBeLessThan(0);
  });
});
