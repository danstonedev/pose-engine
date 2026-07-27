/**
 * SCAPULOHUMERAL RHYTHM — the gate for the shoulder-girdle split.
 *
 * THE DEFECT THIS EXISTS TO PREVENT. The engine realized the ENTIRE commanded
 * shoulder elevation as one quaternion on the UpperArm bone, clavicle
 * untouched. Glenohumeral capacity is ~120°, so a commanded 180° asked the
 * humerus for 180° of glenohumeral rotation and `resolveCommandTarget` returned
 * `'complied'` — the engine certified an anatomically impossible humerus as
 * normal, and shipped postures command into that band. It is the same defect
 * already fixed for the thumb (romRegistry's Thumb1 note), one joint up.
 *
 * WHAT IS AND IS NOT BEING CLAIMED. The commanded value is the HUMEROTHORACIC
 * angle — humerus relative to trunk, scapular contribution included — which is
 * what a goniometric exam measures, so the registry's 180° ceiling is right and
 * stays. Only the REALIZATION changed. Because the readout is world-anchored
 * off the humerus, and the humerus is a CHILD of the clavicle, the girdle share
 * is picked up automatically: commanded == measured still holds exactly.
 *
 * NO GAIT CLAIM. There is no normative dataset of scapulothoracic joint
 * kinematics during walking, and real scapular upward rotation over a walking
 * arm swing is ~0-5°. The setting phase (60° flexion / 30° abduction) keeps
 * walking (±12-15°) and running (~±25°) entirely below the rhythm, so neither
 * authors any girdle rotation from elevation. The gait protraction channel that
 * already exists (gaitModifiers) is untouched. That invariance is gated here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose, applyCustomPose } from '../services/poseRig';
import {
  buildComposedCommandPose,
  girdleSplit,
  measureCommandMotion,
} from '../services/movementCommand';
import { resolveComposedMotion } from '../services/motionSequence';
import { buildTravelRun, buildTravelWalk } from '../services/movementLocomotion';
import { captureJointAngleRestReference, computeJointAngles } from '../services/jointAngles';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let baselinePose: CustomPose;
let rest: ReturnType<typeof captureJointAngleRestReference>;

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
}, 60_000);

interface Read {
  flexion: number;
  abduction: number;
  rotation: number;
  tilt: number;
  upRotation: number;
  protraction: number;
}

/** Apply commands (in order, each absolute from the anatomic baseline) and read
 *  the humerus and clavicle back off the rig. */
function poseAndRead(
  side: 'L' | 'R',
  cmds: { joint: string; targets: { motion: string; degrees: number }[] }[],
): Read {
  let pose: CustomPose = baselinePose;
  for (const c of cmds)
    pose = buildComposedCommandPose(baselinePose, c.joint, c.targets, variantCfg, pose, rest) ?? pose;
  applyCustomPose(skinned.skeleton, variantCfg, pose);
  root.updateMatrixWorld(true);
  const report = computeJointAngles(skinned.skeleton, variantCfg, 'male', rest);
  const arm = `${side}_UpperArm`;
  const clav = `${side}_Shoulder`;
  const m = (j: string, k: string) => measureCommandMotion(report, j, k) ?? NaN;
  return {
    flexion: m(arm, 'shoulderFlexion'),
    abduction: m(arm, 'shoulderAbduction'),
    rotation: m(arm, 'shoulderRotation'),
    tilt: m(clav, 'scapularTilt'),
    upRotation: m(clav, 'upRotation'),
    protraction: m(clav, 'protraction'),
  };
}

/** The girdle share the rhythm assigns to a commanded elevation. */
const girdleShareOf = (deg: number, plane: 'flexion' | 'abduction') =>
  Math.abs(girdleSplit(deg, plane).girdle);

const elevate = (side: 'L' | 'R', motion: string, degrees: number) =>
  poseAndRead(side, [{ joint: `${side}_UpperArm`, targets: [{ motion, degrees }] }]);

describe('scapulohumeral rhythm — the girdle carries its share', () => {
  it('the commanded HUMEROTHORACIC angle is still measured exactly (both planes, both sides)', () => {
    // The whole split is only legitimate if this holds. The engine's contract is
    // commanded == measured; moving rotation onto a second bone must not cost it.
    for (const side of ['L', 'R'] as const) {
      for (const deg of [20, 45, 60, 90, 120, 150, 160]) {
        expect(elevate(side, 'shoulderFlexion', deg).flexion, `${side} flexion ${deg}`).toBeCloseTo(deg, 0);
        expect(elevate(side, 'shoulderAbduction', deg).abduction, `${side} abduction ${deg}`).toBeCloseTo(deg, 0);
      }
    }
  }, 300_000);

  it('below the SETTING PHASE the girdle does not move at all — which is what keeps gait honest', () => {
    for (const side of ['L', 'R'] as const) {
      for (const deg of [5, 15, 25, 45, 60]) {
        const r = elevate(side, 'shoulderFlexion', deg);
        expect(Math.abs(r.tilt), `${side} flexion ${deg} → no girdle tilt`).toBeLessThan(0.5);
      }
      for (const deg of [5, 15, 25, 30]) {
        const r = elevate(side, 'shoulderAbduction', deg);
        expect(Math.abs(r.upRotation), `${side} abduction ${deg} → no girdle upRotation`).toBeLessThan(0.5);
      }
      // Extension / adduction are not elevation — the rhythm must not touch them.
      expect(Math.abs(elevate(side, 'shoulderFlexion', -40).tilt), `${side} extension`).toBeLessThan(0.5);
      expect(Math.abs(elevate(side, 'shoulderAbduction', -40).upRotation), `${side} adduction`).toBeLessThan(0.5);
    }
  }, 300_000);

  it('past the setting phase the girdle share grows, and full ABDUCTION lands on Inman 120 GH + 60 scapular', () => {
    for (const side of ['L', 'R'] as const) {
      const rows: string[] = [];
      let prev = -1;
      for (const deg of [30, 60, 90, 120, 150, 180]) {
        const r = elevate(side, 'shoulderAbduction', deg);
        rows.push(`${deg}→upRot ${r.upRotation.toFixed(1)}`);
        expect(r.upRotation, `${side} abd ${deg}: girdle share is monotone`).toBeGreaterThanOrEqual(prev - 0.5);
        prev = r.upRotation;
      }
      // eslint-disable-next-line no-console
      console.log(`${side} abduction girdle: ${rows.join('  ')}`);
      // At full elevation the humerus is left with exactly its anatomical
      // capacity and the girdle carries the rest — Inman's 120/60.
      const full = elevate(side, 'shoulderAbduction', 180);
      expect(full.upRotation, `${side} full abduction → 60° scapular`).toBeCloseTo(60, 0);
    }
  }, 300_000);

  it('full FLEXION leaves the humerus at 140°, not 180° — the overdraft is 20°, down from 60°', () => {
    // HONEST LIMIT, not a target. The rig has ONE clavicle bone where anatomy has
    // two joints (sternoclavicular + acromioclavicular), so its sagittal
    // excursion is finite: `scapularTilt` bands at 40°. Flexion beyond ~160°
    // needs more girdle than that, and the surplus goes back to the humerus
    // rather than authoring an unphysiologic girdle value. Inflating the band to
    // hide it would move the lie rather than remove it.
    for (const side of ['L', 'R'] as const) {
      expect(elevate(side, 'shoulderFlexion', 160).tilt, `${side} 160 → girdle at its band`).toBeCloseTo(40, 0);
      expect(elevate(side, 'shoulderFlexion', 180).tilt, `${side} 180 → girdle still at its band`).toBeCloseTo(40, 0);
      // …and the humerothoracic readout is still exact, so the pose is right even
      // where the split is imperfect.
      expect(elevate(side, 'shoulderFlexion', 180).flexion, `${side} 180 still measures`).toBeCloseTo(180, 0);
    }
  }, 300_000);

  it('the GH:scapular ratio stays inside the literature band (1.5:1 – 3:1) where the rhythm applies', () => {
    // MEASURED ON THE INCREMENT PAST THE SETTING PHASE, not on the cumulative
    // totals — and the distinction is not pedantry. Inman's 2:1 describes the
    // motion ADDED beyond the setting phase; the first 30° of abduction is
    // essentially all glenohumeral, so the cumulative ratio just past it is
    // necessarily lopsided (at 60° it is 50:10 = 5:1) and comparing that to 2:1
    // would condemn a correct implementation. Kibler 1998 reports 1:1–4:1 by
    // phase and McQuade & Smidt 1998 show it rises under load, so this bands the
    // ratio rather than pinning a point value.
    const SETTING_ABD = 30;
    for (const deg of [60, 90, 120, 150, 180]) {
      const r = elevate('L', 'shoulderAbduction', deg);
      const ghIncrement = deg - r.upRotation - SETTING_ABD;
      const ratio = ghIncrement / r.upRotation;
      // eslint-disable-next-line no-console
      console.log(
        `abduction ${deg}: GH ${(deg - r.upRotation).toFixed(1)} + scapular ${r.upRotation.toFixed(1)} · ` +
          `past-setting ratio ${ratio.toFixed(2)}:1`,
      );
      expect(ratio, `abduction ${deg} ratio`).toBeGreaterThanOrEqual(1.49);
      expect(ratio, `abduction ${deg} ratio`).toBeLessThanOrEqual(3.0);
    }
    // The classic quoted endpoint, cumulative: 180° = 120 GH + 60 scapular = 2:1.
    const full = elevate('L', 'shoulderAbduction', 180);
    expect((180 - full.upRotation) / full.upRotation, 'full elevation is Inman 2:1').toBeCloseTo(2, 1);
  }, 300_000);

  it('the split adds NO apparent axial rotation — the humerus is un-parented from the girdle', () => {
    // THE REGRESSION GATE FOR unparentGirdle, and it is not hypothetical: the
    // first version of the split simply handed the humerus its reduced share and
    // let the clavicle add the rest. Flexion and abduction read back correctly,
    // so it looked right — but the humerus is a CHILD of the clavicle, and
    // tilting the clavicle carried the humerus's axial frame with it. Measured
    // on the rig: 0° → 24.6° at 135° flexion → 104.4° at 180°, against exactly 0°
    // before the split. A visibly wrung arm, and a shoulderRotation readout
    // reporting a twist nobody commanded.
    //
    // The correction (delta = W⁻¹·C⁻¹·W·full) is exact rather than fitted, so the
    // right assertion here is ZERO, not a tolerance band. A calibration table
    // would have hidden this; the engine deleted one of those for the fingers
    // already.
    for (const side of ['L', 'R'] as const) {
      const rows: string[] = [];
      const vals: number[] = [];
      for (const deg of [45, 60, 90, 120, 135, 160, 180]) {
        const r = elevate(side, 'shoulderFlexion', deg);
        rows.push(`${deg}→${r.rotation.toFixed(1)}`);
        vals.push(Math.abs(r.rotation));
      }
      // eslint-disable-next-line no-console
      console.log(`${side} apparent axial rotation through flexion: ${rows.join('  ')}`);
      for (const [i, v] of vals.entries())
        expect(v, `${side} flexion twist #${i}`).toBeLessThan(0.5);
    }
  }, 300_000);

  it('elevation does NOT clobber an independently driven protraction — the one girdle channel gait already uses', () => {
    // writeGirdle is axis-scoped for exactly this: it owns X (tilt) and Z
    // (upRotation) and carries Y (protraction) through. Writing all three would
    // erase gait's protraction every time an arm elevated.
    for (const side of ['L', 'R'] as const) {
      const withBoth = poseAndRead(side, [
        { joint: `${side}_Shoulder`, targets: [{ motion: 'protraction', degrees: 8 }] },
        { joint: `${side}_UpperArm`, targets: [{ motion: 'shoulderFlexion', degrees: 120 }] },
      ]);
      expect(withBoth.protraction, `${side} protraction survives elevation`).toBeCloseTo(8, 0);
      expect(withBoth.tilt, `${side} girdle share still applied`).toBeGreaterThan(15);
      // ~0.5° looser than the isolated case: protraction slides the whole shoulder
      // fore-aft, and the world-anchored humeral readout legitimately sees a little
      // of that. It is cross-coupling between two real motions, not drift.
      expect(Math.abs(withBoth.flexion - 120), `${side} humerothoracic still exact`).toBeLessThan(1);
    }
  }, 300_000);

  it('GAIT is untouched: neither the walk nor the run authors girdle rotation from elevation', () => {
    // The claim the setting phase exists to make, measured rather than asserted.
    // Walking arm swing is ±12-15° and running ~±25°, both inside the setting
    // phase, and there is no normative dataset of scapulothoracic kinematics in
    // walking to justify inventing more. If a future change lowers the setting
    // phase, this fails before the walk silently grows a scapular rhythm.
    for (const [name, build] of [
      ['walk', buildTravelWalk],
      ['run', buildTravelRun],
    ] as const) {
      const resolved = resolveComposedMotion(build(), variantCfg);
      expect(resolved.status).toBe('ok');
      let worstTilt = 0;
      let worstUpRot = 0;
      let protractionSeen = 0;
      for (const kf of resolved.keyframes) {
        for (const side of ['L', 'R'] as const) {
          const arm = kf.targets.filter((t) => t.joint === `${side}_UpperArm`);
          for (const t of arm) {
            if (t.motion === 'shoulderFlexion')
              worstTilt = Math.max(worstTilt, girdleShareOf(t.clampedDegrees, 'flexion'));
            if (t.motion === 'shoulderAbduction')
              worstUpRot = Math.max(worstUpRot, girdleShareOf(t.clampedDegrees, 'abduction'));
          }
          for (const t of kf.targets)
            if (t.joint === `${side}_Shoulder` && t.motion === 'protraction')
              protractionSeen = Math.max(protractionSeen, Math.abs(t.clampedDegrees));
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `${name}: worst elevation-driven girdle tilt ${worstTilt.toFixed(2)}° / upRot ${worstUpRot.toFixed(2)}°; ` +
          `authored protraction ${protractionSeen.toFixed(1)}°`,
      );
      expect(worstTilt, `${name} authors no girdle tilt from flexion`).toBeLessThan(2);
      expect(worstUpRot, `${name} authors no girdle upRotation from abduction`).toBeLessThan(2);
      // …while the girdle channel gait DOES legitimately drive is still driven.
      expect(protractionSeen, `${name} still protracts`).toBeGreaterThan(1);
    }
  }, 300_000);

  it('the girdle share does not LEAK across poses — a reach and a return read their own values', () => {
    // The bug this caught during development: skipping the write when the share
    // was zero left the previous keyframe's tilt on the clavicle, so a commanded
    // 20° measured 36.67°. The write is unconditional and absolute from rest.
    for (const side of ['L', 'R'] as const) {
      const high = elevate(side, 'shoulderFlexion', 150);
      expect(high.tilt, `${side} high reach loads the girdle`).toBeGreaterThan(25);
      const low = elevate(side, 'shoulderFlexion', 20);
      expect(Math.abs(low.tilt), `${side} returning unloads it`).toBeLessThan(0.5);
      expect(low.flexion, `${side} and measures its own value`).toBeCloseTo(20, 0);
    }
  }, 300_000);
});
