/**
 * EYES + MICRO-GAZE (Wave 5 · item 5.1) — the runtime GLBs ship eye bones
 * (CC_Base_L_Eye / CC_Base_R_Eye) that were absent from the bone-name map, so
 * the eyes were frozen in-socket ("taxidermy at tutorial camera distances").
 * This wave maps them (canonical L_Eye / R_Eye) and drives them with a
 * LIVE-ONLY overlay: gaze-absorb (the eyes counter-rotate the head's residual
 * yaw/pitch — the stabilizeGaze leftover — so the gaze point stays fixed) plus
 * seeded saccades with ~150 ms settles and slow inter-saccadic drift. Blink
 * morphs were stripped at export — rotation-in-socket is the whole budget.
 *
 * Gated at three layers:
 *  1) PURE PHASE FUNCTIONS (services/eyeGaze) — bounds, determinism, interval
 *     distribution, settle timing, clean-mode zeros.
 *  2) ON THE RIG — the eye bones resolve through the map on the real runtime
 *     GLBs (both variants), the stage's application math is replicated and the
 *     world eye rotation stays within caps, the absorb geometrically restores
 *     the gaze direction, the undo is byte-exact, and mapping the eyes enrolls
 *     them in NO clinical machinery (no ROM row, no clamp strategy, no pose
 *     handle, no tracked bone, no goniometry change).
 *  3) SOURCE PINS (the stage is WebGL + Svelte — unmountable here, same
 *     pattern as stageReliability.test.ts): the eye undo runs BEFORE the
 *     recording tap; the re-bake runs AFTER the tap and is NOT idle-gated
 *     (eyes live during motion too); every serialize/export/takeover path
 *     lifts the eye deltas; the undo is an exact stored-base restore.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { computeJointAngles, captureJointAngleRestReference } from '../services/jointAngles';
import { hasClampStrategy } from '../services/poseRomClamp';
import { ROM_JOINT_ROWS } from '../services/romRegistry';
import { DEFAULT_TRACKED_BONES } from '../services/motionRecording';
import {
  eyeGazeAngles,
  saccadeGaze,
  saccadeIntervalsS,
  saccadeTargetsDeg,
  EYE_SACCADE_MIN_INTERVAL_S,
  EYE_SACCADE_MAX_INTERVAL_S,
  EYE_SACCADE_SETTLE_S,
  EYE_GAZE_RANGE_DEG,
  EYE_PITCH_SCALE,
  EYE_DRIFT_PEAK_DEG,
  EYE_ABSORB_CAP_DEG,
  EYE_TOTAL_CAP_DEG,
  EYE_SACCADE_CYCLE_N,
} from '../services/eyeGaze';
import { BODY_VARIANTS, normalizeBoneNameForVariant } from '../anatomy/bodyVariants';

const stageSource = readFileSync(
  fileURLToPath(new URL('../ExamStage3D.svelte', import.meta.url)),
  'utf8',
);

async function loadGlb(url: URL): Promise<THREE.Group> {
  const buf = readFileSync(fileURLToPath(url));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  return gltf.scene;
}

// ── 1) Pure phase functions ──────────────────────────────────────────────────

describe('eye micro-gaze — pure phase functions', () => {
  it('saccade intervals are irregular and strictly within the 0.8–3 s band, per seed', () => {
    for (const seed of [0, 7.5, 42, 123.456, 999]) {
      const intervals = saccadeIntervalsS(seed);
      expect(intervals).toHaveLength(EYE_SACCADE_CYCLE_N);
      for (const d of intervals) {
        expect(d).toBeGreaterThanOrEqual(EYE_SACCADE_MIN_INTERVAL_S);
        expect(d).toBeLessThanOrEqual(EYE_SACCADE_MAX_INTERVAL_S);
      }
      // Irregular, never metronomic: many distinct values with real spread.
      const distinct = new Set(intervals.map((d) => d.toFixed(3)));
      expect(distinct.size, 'fixation intervals vary').toBeGreaterThanOrEqual(8);
      const mean = intervals.reduce((s, d) => s + d, 0) / intervals.length;
      const sd = Math.sqrt(
        intervals.reduce((s, d) => s + (d - mean) ** 2, 0) / intervals.length,
      );
      expect(sd, 'the interval spread is real (not near-constant)').toBeGreaterThan(0.15);
    }
    // Different seeds → different schedules (stages never sync up).
    expect(saccadeIntervalsS(1)).not.toEqual(saccadeIntervalsS(2));
  });

  it('fixation targets are a bounded walk: |yaw| ≤ 4°, |pitch| ≤ 2.4°, and they actually move', () => {
    for (const seed of [3, 42, 77.7]) {
      const targets = saccadeTargetsDeg(seed);
      expect(targets).toHaveLength(EYE_SACCADE_CYCLE_N);
      for (const t of targets) {
        expect(Math.abs(t.yawDeg)).toBeLessThanOrEqual(EYE_GAZE_RANGE_DEG + 1e-9);
        expect(Math.abs(t.pitchDeg)).toBeLessThanOrEqual(
          EYE_GAZE_RANGE_DEG * EYE_PITCH_SCALE + 1e-9,
        );
      }
      const distinctYaw = new Set(targets.map((t) => t.yawDeg.toFixed(2)));
      expect(distinctYaw.size, 'fixations move around').toBeGreaterThanOrEqual(8);
    }
  });

  it('saccadeGaze: deterministic, bounded, amount 0 ⇒ exactly {0, 0}, NaN-proof', () => {
    const bound = EYE_GAZE_RANGE_DEG + EYE_DRIFT_PEAK_DEG;
    for (let t = 0; t <= 40; t += 0.037) {
      const a = saccadeGaze(t, 1, 42);
      const b = saccadeGaze(t, 1, 42);
      expect(a).toEqual(b); // deterministic
      expect(Math.abs(a.yawDeg)).toBeLessThanOrEqual(bound + 1e-9);
      expect(Math.abs(a.pitchDeg)).toBeLessThanOrEqual(bound + 1e-9);
      // amount scales: half dial is strictly inside the full-dial bound.
      const h = saccadeGaze(t, 0.5, 42);
      expect(Math.abs(h.yawDeg)).toBeLessThanOrEqual(0.5 * bound + 1e-9);
    }
    expect(saccadeGaze(3.3, 0, 42)).toEqual({ yawDeg: 0, pitchDeg: 0 });
    expect(saccadeGaze(Number.NaN, 1, 42)).toEqual({ yawDeg: 0, pitchDeg: 0 });
    expect(saccadeGaze(3.3, Number.NaN, 42)).toEqual({ yawDeg: 0, pitchDeg: 0 });
  });

  it('the gaze SHIFTS at each interval boundary with a ~150 ms settle (before: previous fixation; after settle: new fixation; drift-sized tolerance)', () => {
    const seed = 42;
    const intervals = saccadeIntervalsS(seed);
    const targets = saccadeTargetsDeg(seed);
    const tol = EYE_DRIFT_PEAK_DEG + 1e-6;
    let boundary = 0;
    let checked = 0;
    for (let k = 0; k < EYE_SACCADE_CYCLE_N; k += 1) {
      const prev = targets[(k + EYE_SACCADE_CYCLE_N - 1) % EYE_SACCADE_CYCLE_N]!;
      const tgt = targets[k]!;
      // Just before the boundary: still at the PREVIOUS fixation.
      if (k > 0) {
        const before = saccadeGaze(boundary - 1e-4, 1, seed);
        expect(Math.abs(before.yawDeg - prev.yawDeg)).toBeLessThanOrEqual(tol);
      }
      // Just after the settle (~150 ms): arrived at the NEW fixation.
      const after = saccadeGaze(boundary + EYE_SACCADE_SETTLE_S + 1e-4, 1, seed);
      expect(Math.abs(after.yawDeg - tgt.yawDeg)).toBeLessThanOrEqual(tol);
      expect(Math.abs(after.pitchDeg - tgt.pitchDeg)).toBeLessThanOrEqual(tol);
      // Mid-settle: strictly between the two fixations (the fast conjugate ramp).
      if (Math.abs(tgt.yawDeg - prev.yawDeg) > 0.5) {
        const mid = saccadeGaze(boundary + EYE_SACCADE_SETTLE_S / 2, 1, seed);
        const lo = Math.min(prev.yawDeg, tgt.yawDeg) - tol;
        const hi = Math.max(prev.yawDeg, tgt.yawDeg) + tol;
        expect(mid.yawDeg).toBeGreaterThanOrEqual(lo);
        expect(mid.yawDeg).toBeLessThanOrEqual(hi);
        checked += 1;
      }
      boundary += intervals[k]!;
    }
    expect(checked, 'the sweep hit real mid-saccade samples').toBeGreaterThan(3);
  });

  it('eyeGazeAngles: absorb is the exact negated (capped) residual on top of the saccade; totals hard-capped at ±8°; amount 0 zeroes EVERYTHING', () => {
    // Additivity below the caps: small residuals shift the output exactly.
    for (const t of [0.4, 2.9, 11.13]) {
      const base = eyeGazeAngles(t, 1, 42, 0, 0);
      const shifted = eyeGazeAngles(t, 1, 42, 2, -1.5);
      expect(shifted.yawDeg - base.yawDeg).toBeCloseTo(-2, 10);
      expect(shifted.pitchDeg - base.pitchDeg).toBeCloseTo(1.5, 10);
    }
    // Hard caps: even absurd residuals can never rotate the eye past ±8°.
    for (let t = 0; t <= 20; t += 0.11) {
      for (const [ry, rp] of [
        [30, -30],
        [-500, 500],
        [Number.NaN, 4],
        [8.01, -8.01],
      ] as const) {
        const g = eyeGazeAngles(t, 1, 42, ry, rp);
        expect(Math.abs(g.yawDeg)).toBeLessThanOrEqual(EYE_TOTAL_CAP_DEG);
        expect(Math.abs(g.pitchDeg)).toBeLessThanOrEqual(EYE_TOTAL_CAP_DEG);
      }
    }
    expect(EYE_ABSORB_CAP_DEG).toBeLessThanOrEqual(EYE_TOTAL_CAP_DEG);
    // Clean mode: amount 0 zeroes absorb AND saccades, even with a residual.
    expect(eyeGazeAngles(5.5, 0, 42, 3, -2)).toEqual({ yawDeg: 0, pitchDeg: 0 });
  });
});

// ── 2) On the rig ────────────────────────────────────────────────────────────

describe('eye micro-gaze — measured on the rig', () => {
  const variantCfg = BODY_VARIANTS.male;
  const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
  let root: THREE.Object3D;
  let skinned: THREE.SkinnedMesh;
  let bones: Map<string, THREE.Bone>;
  let rest: ReturnType<typeof captureJointAngleRestReference>;
  let rootRestQuat: THREE.Quaternion;

  beforeAll(async () => {
    root = await loadGlb(GLB_URL);
    root.scale.setScalar(variantCfg.pose.rootScale);
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
    });
    root.updateMatrixWorld(true);
    applyAnatomicPose(root, variantCfg);
    root.updateMatrixWorld(true);
    bones = buildBoneByPoseKey(skinned.skeleton, variantCfg) as Map<string, THREE.Bone>;
    rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
    rootRestQuat = root.quaternion.clone();
  });

  /** Replicate the stage's applyEyeGaze residual measurement (root-frame head
   *  deviation from the captured rest relation). */
  function measureResidualDeg(): { yawDeg: number; pitchDeg: number } {
    const head = bones.get('Head')!;
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
    const headQ = head.getWorldQuaternion(new THREE.Quaternion());
    const relNow = rootQ.clone().invert().multiply(headQ);
    const hr = rest.worldQuats.Head!;
    const relRest = rootRestQuat
      .clone()
      .invert()
      .multiply(new THREE.Quaternion(hr[0], hr[1], hr[2], hr[3]));
    const residual = relNow.multiply(relRest.invert());
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(residual);
    return {
      yawDeg: (Math.atan2(f.x, f.z) * 180) / Math.PI,
      pitchDeg: (Math.asin(Math.max(-1, Math.min(1, f.y))) * 180) / Math.PI,
    };
  }

  /** Replicate the stage's W application: gaze angles in the ROOT frame,
   *  converted into the shared eye-parent local frame and premultiplied onto
   *  both eyes. Returns an exact undo (the stage's sandwich). */
  function applyEyeAngles(yawDeg: number, pitchDeg: number): () => void {
    const eyeL = bones.get('L_Eye')!;
    const eyeR = bones.get('R_Eye')!;
    const baseL = eyeL.quaternion.clone();
    const baseR = eyeR.quaternion.clone();
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
    const wRoot = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), (yawDeg * Math.PI) / 180)
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          (-pitchDeg * Math.PI) / 180,
        ),
      );
    const parentQ = eyeL.parent!.getWorldQuaternion(new THREE.Quaternion());
    const wLocal = parentQ
      .clone()
      .invert()
      .multiply(rootQ)
      .multiply(wRoot)
      .multiply(rootQ.clone().invert())
      .multiply(parentQ);
    eyeL.quaternion.premultiply(wLocal);
    eyeR.quaternion.premultiply(wLocal);
    root.updateMatrixWorld(true);
    return () => {
      eyeL.quaternion.copy(baseL);
      eyeR.quaternion.copy(baseR);
      root.updateMatrixWorld(true);
    };
  }

  /** The full stage pipeline for one instant: measure residual → eyeGazeAngles
   *  → apply. */
  function applyGazeAt(tSec: number, amount: number, seed: number): () => void {
    const r = measureResidualDeg();
    const { yawDeg, pitchDeg } = eyeGazeAngles(tSec, amount, seed, r.yawDeg, r.pitchDeg);
    if (amount <= 0) return () => {}; // the stage's clean-mode early-out
    return applyEyeAngles(yawDeg, pitchDeg);
  }

  it('BOTH eye bones resolve through the bone-name map on the male runtime GLB (and share the facial parent)', () => {
    const eyeL = bones.get('L_Eye');
    const eyeR = bones.get('R_Eye');
    expect(eyeL?.name).toBe('CC_Base_L_Eye');
    expect(eyeR?.name).toBe('CC_Base_R_Eye');
    expect(eyeL!.parent).toBe(eyeR!.parent); // conjugate application is valid
  });

  it('BOTH eye bones resolve on the FEMALE runtime GLB too (name-map normalization)', async () => {
    const femRoot = await loadGlb(
      new URL('../../models/painmap3D_female.runtime.glb', import.meta.url),
    );
    const found: string[] = [];
    femRoot.traverse((o) => {
      if (!(o as THREE.Bone).isBone) return;
      const n = normalizeBoneNameForVariant(o.name, BODY_VARIANTS.female.boneNameMap);
      if (n.canonical === 'Eye') {
        found.push(`${n.side === 'Left' ? 'L_' : n.side === 'Right' ? 'R_' : ''}${n.canonical}`);
      }
    });
    expect(found.sort()).toEqual(['L_Eye', 'R_Eye']);
  });

  it('mapping the eyes enrolls them in NO clinical machinery: no ROM row, no clamp strategy, no pose handle, no tracked bone', () => {
    // Goniometry UI rows are the static ROM registry — the eyes never appear.
    expect(ROM_JOINT_ROWS.some((j) => /Eye/.test(j.canonicalKey))).toBe(false);
    // The per-bone ROM clamp has no strategy for them (clamp calls no-op).
    expect(hasClampStrategy('L_Eye')).toBe(false);
    expect(hasClampStrategy('R_Eye')).toBe(false);
    // The pose rig exposes no draggable eye handle.
    expect(variantCfg.poseRig.handles.some((h) => /Eye/.test(h.canonicalKey))).toBe(false);
    // Recordings' world-trajectory track set is unchanged.
    expect(DEFAULT_TRACKED_BONES.some((k) => /Eye/.test(k))).toBe(false);
  });

  it('the measured goniometry report is BYTE-IDENTICAL with the overlay baked vs lifted (eyes are invisible to measurement)', () => {
    // Drop the report's wall-clock `at` stamp — only the measured angles matter.
    const measure = () => {
      const report: Record<string, unknown> = {
        ...computeJointAngles(skinned.skeleton, variantCfg, variantCfg.id, rest),
      };
      delete report.at;
      return JSON.stringify(report);
    };
    const before = measure();
    const undo = applyGazeAt(4.2, 1, 42);
    const during = measure();
    undo();
    expect(during).toBe(before);
  });

  it('pose serialization carries the eyes AT REST only: apply → undo leaves the serialized pose byte-identical (the sandwich guarantee)', () => {
    const before = JSON.stringify(serializeCustomPose(skinned.skeleton, variantCfg, 'male'));
    expect(before).toContain('"L_Eye"'); // mapped: the clean rest quat IS serialized
    expect(before).toContain('"R_Eye"');
    const undo = applyGazeAt(7.7, 1, 42);
    undo();
    const after = JSON.stringify(serializeCustomPose(skinned.skeleton, variantCfg, 'male'));
    expect(after).toBe(before);
  });

  it('world eye rotation stays within the caps across a 30 s sweep (rest head) and under an extreme forced head yaw', () => {
    const eyeL = bones.get('L_Eye')!;
    const restQ = eyeL.getWorldQuaternion(new THREE.Quaternion());
    let maxDeg = 0;
    let seen = 0;
    for (let t = 0; t <= 30; t += 1 / 30) {
      const undo = applyGazeAt(t, 1, 42);
      const q = eyeL.getWorldQuaternion(new THREE.Quaternion());
      const deg = (q.angleTo(restQ) * 180) / Math.PI;
      maxDeg = Math.max(maxDeg, deg);
      if (deg > 0.5) seen += 1;
      undo();
    }
    // eslint-disable-next-line no-console
    console.log(`eye rig: peak world eye rotation ${maxDeg.toFixed(2)}° over 30 s (amount 1)`);
    // Rest head → residual ≈ 0 → the budget is saccades + drift (≤ ~4.35°/axis).
    expect(maxDeg, 'saccades stay small').toBeLessThanOrEqual(8.01);
    expect(seen, 'but the eyes are visibly ALIVE (not sub-perceptual)').toBeGreaterThan(10);

    // Extreme: yaw the HEAD +20° in the root frame — the absorb caps at 8°/axis
    // and the total (absorb + saccade, clamped per axis) never exceeds ±8°/axis.
    const head = bones.get('Head')!;
    const headParentQ = head.parent!.getWorldQuaternion(new THREE.Quaternion());
    const headBase = head.quaternion.clone();
    const wYaw = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      (20 * Math.PI) / 180,
    );
    head.quaternion.copy(
      headParentQ.clone().invert().multiply(wYaw).multiply(headParentQ).multiply(headBase),
    );
    root.updateMatrixWorld(true);
    expect(measureResidualDeg().yawDeg).toBeCloseTo(20, 1); // the stage's residual read works
    const eyeYawedQ = eyeL.getWorldQuaternion(new THREE.Quaternion());
    for (const t of [0.3, 5.5, 17.2]) {
      const undo = applyGazeAt(t, 1, 42);
      const q = eyeL.getWorldQuaternion(new THREE.Quaternion());
      const deg = (q.angleTo(eyeYawedQ) * 180) / Math.PI;
      // Per-axis caps of 8° ⇒ the composed rotation is ≤ ~11.4° total.
      expect(deg).toBeLessThanOrEqual(11.5);
      undo();
    }
    head.quaternion.copy(headBase);
    root.updateMatrixWorld(true);
  });

  it('GAZE ABSORB geometry: after a +3° root-frame head yaw, a −3° eye counter restores the eye WORLD orientation exactly (the gaze point holds)', () => {
    const eyeL = bones.get('L_Eye')!;
    const eyeR = bones.get('R_Eye')!;
    const head = bones.get('Head')!;
    const restL = eyeL.getWorldQuaternion(new THREE.Quaternion());
    const restR = eyeR.getWorldQuaternion(new THREE.Quaternion());
    const headBase = head.quaternion.clone();
    const headParentQ = head.parent!.getWorldQuaternion(new THREE.Quaternion());
    for (const [axis, resKey, gaze] of [
      [new THREE.Vector3(0, 1, 0), 'yawDeg', { yaw: -3, pitch: 0 }],
      [new THREE.Vector3(1, 0, 0), 'pitchDeg', { yaw: 0, pitch: -3 }],
    ] as const) {
      // Rotate the head 3° about the root axis (yaw case; the pitch case uses
      // −3° about X, which tips the head UP = +3° residual pitch).
      const sign = resKey === 'yawDeg' ? 1 : -1;
      const w = new THREE.Quaternion().setFromAxisAngle(axis, (sign * 3 * Math.PI) / 180);
      head.quaternion.copy(
        headParentQ.clone().invert().multiply(w).multiply(headParentQ).multiply(headBase),
      );
      root.updateMatrixWorld(true);
      const res = measureResidualDeg();
      expect(res[resKey]).toBeCloseTo(3, 1); // the stage measures the residual it absorbs
      // The eyes drifted WITH the head…
      const yawedL = eyeL.getWorldQuaternion(new THREE.Quaternion());
      expect((yawedL.angleTo(restL) * 180) / Math.PI).toBeGreaterThan(2.5);
      // …and the counter-rotation returns their WORLD orientation to rest.
      const undo = applyEyeAngles(gaze.yaw, gaze.pitch);
      const absorbedL = eyeL.getWorldQuaternion(new THREE.Quaternion());
      const absorbedR = eyeR.getWorldQuaternion(new THREE.Quaternion());
      expect((absorbedL.angleTo(restL) * 180) / Math.PI).toBeLessThan(0.01);
      expect((absorbedR.angleTo(restR) * 180) / Math.PI).toBeLessThan(0.01);
      undo();
      head.quaternion.copy(headBase);
      root.updateMatrixWorld(true);
    }
  });

  it('the undo is EXACT and the overlay touches ONLY the two eye bones; clean mode (amount 0) is a true statue', () => {
    const eyeL = bones.get('L_Eye')!;
    const eyeR = bones.get('R_Eye')!;
    const untouched = ['Head', 'Neck', 'Spine_Upper', 'Spine_Lower', 'Hips', 'L_Foot', 'R_Foot'];
    const baseL = eyeL.quaternion.toArray();
    const baseR = eyeR.quaternion.toArray();
    const baseOthers = untouched.map((k) => bones.get(k)!.quaternion.toArray());
    for (const t of [0.1, 2.6, 7.77]) {
      const undo = applyGazeAt(t, 1, 42);
      expect(eyeL.quaternion.toArray(), 'the overlay really moves the eye').not.toEqual(baseL);
      untouched.forEach((k, i) => {
        expect(bones.get(k)!.quaternion.toArray(), `${k} untouched`).toEqual(baseOthers[i]);
      });
      undo();
      expect(eyeL.quaternion.toArray()).toEqual(baseL);
      expect(eyeR.quaternion.toArray()).toEqual(baseR);
    }
    // Determinism on the rig: same instant twice ⇒ byte-identical eye quats.
    const undoA = applyGazeAt(3.3, 0.7, 42);
    const qa = eyeL.quaternion.toArray();
    undoA();
    const undoB = applyGazeAt(3.3, 0.7, 42);
    expect(eyeL.quaternion.toArray()).toEqual(qa);
    undoB();
    // Clean mode: amount 0 applies NOTHING.
    const undoC = applyGazeAt(9.9, 0, 42);
    expect(eyeL.quaternion.toArray()).toEqual(baseL);
    undoC();
  });
});

// ── 3) Stage wiring (source pins) ────────────────────────────────────────────

describe('eye micro-gaze — stage wiring (source pins)', () => {
  it('the loop LIFTS the eye deltas before the recording tap (recordings sample the eyes at rest)', () => {
    expect(stageSource).toMatch(
      /if \(undoEyeGaze\(\)\) renderNeeded = true;[\s\S]{0,700}if \(recording\) \{/,
    );
  });

  it('the re-bake runs AFTER the tap and is NOT idle-gated — the eyes live during motion too', () => {
    // The idle-gated block closes, THEN the eye apply runs unconditionally.
    // (Window widened 500→1200: the SEAM-9 motion-time-liveliness else-if — the
    // realism breathing/micro-sway, also re-applied AFTER the tap so recordings
    // stay clean — now sits between the idle block's close and the eye apply.)
    expect(stageSource).toMatch(
      /applyIdleOverlays\(motionDelta\)\s*\n\s*\) \{\s*\n\s*renderNeeded = true;\s*\n\s*\}[\s\S]{0,1200}if \(applyEyeGaze\(motionDelta\)\) renderNeeded = true;/,
    );
    // And the eye apply is OUTSIDE the truly-idle condition: nothing between the
    // first idle-overlay call and the eye apply RE-GATES on the idle predicate
    // (the interposed motion-liveliness else-if uses the NON-negated motion
    // predicate, so the negated idle tokens still never appear here).
    const between = stageSource.split('applyIdleOverlays(motionDelta)')[1]!.split(
      'applyEyeGaze(motionDelta)',
    )[0]!;
    expect(between).not.toMatch(/!activeMotionId|!composedActive|!activeTrajectory/);
  });

  it('captureFrame builds from the CLEAN pose and restores the eyes EXACTLY (SEAM-9 snapshot, not a stale-base re-derive)', () => {
    // SEAM-9 — the eye deltas are restored by an EXACT snapshot of the applied
    // locals (captureAppliedEyeGaze), NOT re-derived via applyEyeGaze(0). A
    // re-derive recomputes the gaze-absorb against the head/root as the idle
    // re-bake leaves them — a STALE BASE if that pose differs at all. undoEyeGaze
    // still lifts the eyes around the capture; the snapshot closure copies the
    // exact locals back after (base-independent — an eye local is frame-invariant).
    expect(stageSource).toMatch(
      /const eyeRestore = captureAppliedEyeGaze\(\);[\s\S]{0,200}undoEyeGaze\(\);[\s\S]{0,400}buildFrameNowClean\(tMs\);[\s\S]{0,400}if \(eyeRestore\) eyeRestore\(\);/,
    );
    // The snapshot clones the CURRENT applied eye locals and copies them back
    // verbatim, re-setting eyeGazeOn so the next frame's undo stays balanced.
    expect(stageSource).toMatch(
      /function captureAppliedEyeGaze\(\)[\s\S]{0,500}quaternion\.clone\(\)[\s\S]{0,300}quaternion\.copy\(qL\)[\s\S]{0,300}eyeGazeOn = true;/,
    );
  });

  it('every serialize/export path lifts the eye deltas first: getPose, committed posing, pose-play snapshot, GLB export', () => {
    expect(stageSource).toMatch(
      /getPose: \(\) => \{[\s\S]{0,500}undoEyeGaze\(\);[\s\S]{0,200}serializeCustomPose/,
    );
    expect(stageSource).toMatch(
      /undoEyeGaze\(\); \/\/ committed poses carry the eyes at rest[\s\S]{0,300}serializeCustomPose/,
    );
    expect(stageSource).toMatch(
      /undoEyeGaze\(\); \/\/ nor a baked eye delta[\s\S]{0,200}undoIdleOverlays\(\);\s*\n\s*posePlayPosed = serializeCustomPose/,
    );
    expect(stageSource).toMatch(
      /exportAnimationGlb[\s\S]{0,900}undoEyeGaze\(\); \/\/ exported bone tracks carry the eyes at rest/,
    );
  });

  it('every takeover lifts the eye deltas alongside the idle lift: exam command, clip, composed playback, scrub, pose load/reset, model dispose', () => {
    expect(stageSource).toMatch(
      /undoIdleOverlays\(\); \/\/ the command starts from the clean idle pose\s*\n\s*undoEyeGaze\(\);/,
    );
    expect(stageSource).toMatch(
      /undoIdleOverlays\(\); \/\/ playback starts from the clean idle pose\s*\n\s*undoEyeGaze\(\);/,
    );
    expect(stageSource).toMatch(
      /undoIdleOverlays\(\); \/\/ the clip starts from the clean idle pose\s*\n\s*undoEyeGaze\(\);/,
    );
    expect(stageSource).toMatch(
      /undoEyeGaze\(\); \/\/ eye deltas lift before the absolute pose writes/,
    );
    expect(stageSource).toMatch(
      /undoEyeGaze\(\); \/\/ eye deltas too — the stored bases die with the model/,
    );
    // Fresh skeleton voids the bake flag (stored bases belong to dead bones).
    expect(stageSource).toMatch(/eyeGazeOn = false; \/\/ same for the eye micro-gaze bake/);
  });

  it('the undo is an EXACT stored-base restore of both eyes, and clean mode applies nothing (dirty flag honest)', () => {
    expect(stageSource).toMatch(
      /function undoEyeGaze\(\): boolean \{[\s\S]{0,500}copy\(_eyeBaseLQ\)[\s\S]{0,300}copy\(_eyeBaseRQ\)/,
    );
    expect(stageSource).toMatch(
      /function applyEyeGaze\(dtSec: number\): boolean \{[\s\S]{0,300}if \(amount <= 0[^\n]*return false;/,
    );
  });

  it('the residual is measured in the MODEL-ROOT frame (travel heading / root reorientation never register as residual)', () => {
    expect(stageSource).toMatch(
      /function applyEyeGaze[\s\S]{0,1500}modelRoot\.getWorldQuaternion[\s\S]{0,600}rootRestQuat/,
    );
  });
});
