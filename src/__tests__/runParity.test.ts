/**
 * RUN GROUNDING PARITY (roadmap 4.3) — the run gets the walk's polish:
 *
 *   1. TOUCHDOWN ABSORPTION: each landing runs touchdown → absorption → recoil.
 *      The landing knee YIELDS an extra ~10° past its stance-drive value right
 *      after contact (the loading response), then recoils into the drive —
 *      authored keyframes in the run cycle, measured here on the rig.
 *   2. FOOT-PLANT CONTACTS: buildTravelRun pins each stance foot for its
 *      touchdown→toe-off window (the walk's contact machinery, on the run's own
 *      phase timing); FLIGHT phases carry no contact by definition — both feet
 *      are measurably airborne mid-flight, never pinned.
 *   3. buildTravelRun — the running sibling of buildTravelWalk: footDrivenTravel
 *      over the run cycle, with the derivation HOLDING its advance through each
 *      flight gap (no grounded reference) and resuming at touchdown
 *      (rootMotion deriveFootDrivenTravel + FeetZ.bothAirborne).
 *
 * Ends are CYCLIC fly-throughs (the pre-Wave-3 travel-walk pattern) — the run
 * does not author a braking deceleration; a 2-3 step run-down is future work.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { measureContactSlide } from '../services/footContact';
import { measureCommandMotion } from '../services/movementCommand';
import { buildRun, buildTravelRun } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let rootRest0: THREE.Vector3;
let rootQuat0: THREE.Quaternion;

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
  rootRest0 = root.position.clone();
  rootQuat0 = root.quaternion.clone();
});

function resetHarness(): void {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
}

function sampleTravelRun(opts: { speed?: number } = {}): {
  rec: MotionRecording;
  resolved: ReturnType<typeof resolveComposedMotion>;
} {
  resetHarness();
  const resolved = resolveComposedMotion(buildTravelRun(opts), variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 120,
  });
  return { rec, resolved };
}

const hipsDz = (rec: MotionRecording) =>
  rec.frames[rec.frames.length - 1]!.worldTracks!['Hips']![2] - rec.frames[0]!.worldTracks!['Hips']![2];

/** Frame nearest tMs. */
const frameAt = (rec: MotionRecording, tMs: number) =>
  rec.frames.reduce((b, f) => (Math.abs(f.tMs - tMs) < Math.abs(b.tMs - tMs) ? f : b));

const kneeSeries = (rec: MotionRecording, side: 'L' | 'R'): number[] =>
  rec.frames.map(
    (f) => measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, `${side}_Leg`, 'kneeFlexion') ?? 0,
  );

/** The run's authored phase clock (per-keyframe durations of the resolved
 *  motion — asserted un-bumped below, so authored time == trajectory time). */
function phaseClock(resolved: ReturnType<typeof resolveComposedMotion>): number[] {
  const arrive: number[] = [];
  let cursor = 0;
  for (const kf of resolved.keyframes) {
    cursor += kf.durationMs + kf.holdMs;
    arrive.push(cursor);
  }
  return arrive;
}

describe('buildTravelRun — shape of the plan', () => {
  it('is the run cycle ×2 + a closing touchdown — planted, non-looping, foot-driven, contact-pinned', () => {
    const m = buildTravelRun();
    expect(m.keyframes.length).toBe(17); // 4 steps × (touchdown, absorb, drive, flight) + closing touchdown
    expect(m.loop ?? false).toBe(false);
    expect(m.stance).toBe('planted');
    expect(m.footDrivenTravel).toBe(true);
    // CYCLIC ends (no authored initiation/termination — noted future work), so
    // the trajectory enters/exits at stride velocity instead of braking.
    expect(m.settleEnds ?? false).toBe(false);
    // One stance window per step. Only the ENTRY window travel-locks (and it
    // extends back to t=0 so the derived root never retreats through the
    // standing→first-touchdown transition); steady-state stances stay on the
    // measured-feet heuristic (a lock's advance floor over-runs the pinned
    // foot and eats the absorption yield — see the builder note). Each CONTACT
    // opens only at its foot's LANDING (pinning earlier would capture the
    // still-airborne foot).
    expect(m.gaitStanceWindowsMs?.length).toBe(4);
    expect(m.gaitStanceWindowsMs![0]!.travelLock).toBe(true);
    expect(m.gaitStanceWindowsMs!.slice(1).every((w) => w.travelLock == null)).toBe(true);
    expect(m.gaitStanceWindowsMs![0]!.fromMs).toBe(0);
    expect(m.contacts?.map((c) => c.foot)).toEqual(['R_Foot', 'L_Foot', 'R_Foot', 'L_Foot']);
    expect(m.contacts![0]!.fromMs).toBeGreaterThan(0); // pin at landing, not from standing
    for (const [i, c] of m.contacts!.entries()) {
      expect(c.toMs).toBe(m.gaitStanceWindowsMs![i]!.toMs);
      if (i > 0) expect(c.fromMs).toBe(m.gaitStanceWindowsMs![i]!.fromMs);
    }
    // NO vertical calibration: the walk-shaped smoothed table is grounded-cycle
    // machinery — on a flight gait it erased the touchdown yield and snapped at
    // contact (rig-measured); the run's grounded arc is authored in-band and
    // gated below instead.
    expect(m.verticalCalibrationCm).toBeUndefined();
    // Every duration is authored AT/ABOVE the engine floor and inside its
    // velocity-class budget, so the resolver never re-times a keyframe — the
    // contact windows above stay exact in trajectory time.
    const resolved = resolveComposedMotion(m, variantCfg);
    expect(resolved.status).toBe('ok');
    expect(resolved.keyframes.some((k) => k.timingAdjusted)).toBe(false);
    for (const [i, kf] of resolved.keyframes.entries()) {
      expect(kf.durationMs, `kf${i} duration passes through`).toBe(m.keyframes[i]!.durationMs);
    }
  });
});

describe('buildTravelRun — measured on the rig', () => {
  it('advances the body >1 m with the stride emerging from the FK (held through flight)', () => {
    const { rec } = sampleTravelRun();
    const dz = hipsDz(rec);
    // eslint-disable-next-line no-console
    console.log(`travel run: advances ${dz.toFixed(2)} m over ${rec.frames[rec.frames.length - 1]!.tMs.toFixed(0)} ms`);
    expect(dz, 'body advances +Z more than 1 m').toBeGreaterThan(1.0);
    // …and the advance is monotone-ish: the root never retreats measurably
    // (the flight-gap hold means no mid-air moonwalk).
    const zs = rec.frames.map((f) => f.worldTracks!['Hips']![2]);
    let maxRetreat = 0;
    for (let i = 1; i < zs.length; i += 1) maxRetreat = Math.max(maxRetreat, zs[i - 1]! - zs[i]!);
    // eslint-disable-next-line no-console
    console.log(`travel run: max single-frame retreat ${(maxRetreat * 100).toFixed(2)} cm`);
    expect(maxRetreat, 'the root never backs up through a flight gap').toBeLessThan(0.02);
  });

  it('each stance foot stays world-fixed during its ground window — slide <4 cm', () => {
    const { rec, resolved } = sampleTravelRun();
    for (const [i, c] of resolved.contacts!.entries()) {
      const slide = measureContactSlide(rec, c.foot, c.fromMs!, c.toMs!);
      // eslint-disable-next-line no-console
      console.log(`stance ${i} (${c.foot} ${c.fromMs}–${c.toMs} ms): slide ${(slide.horizontalM * 100).toFixed(1)} cm over ${slide.frames} frames`);
      expect(slide.frames, `window ${i} sampled`).toBeGreaterThan(10);
      expect(slide.horizontalM, `stance ${i} (${c.foot}) slide`).toBeLessThan(0.04);
    }
  });

  it('flight phases keep BOTH feet airborne — no contact pin mid-flight', () => {
    const { rec, resolved } = sampleTravelRun();
    const arrive = phaseClock(resolved);
    const lY = rec.frames.map((f) => f.worldTracks!['L_Foot']![1]);
    const rY = rec.frames.map((f) => f.worldTracks!['R_Foot']![1]);
    const floor = Math.min(...lY, ...rY);
    // Per step i: flight-knot arrival = keyframe index 4i+3. Mid-flight (the
    // knot itself) must have both feet clearly off the floor.
    for (let i = 0; i < 4; i += 1) {
      const f = frameAt(rec, arrive[4 * i + 3]!);
      const lo = Math.min(f.worldTracks!['L_Foot']![1], f.worldTracks!['R_Foot']![1]) - floor;
      // eslint-disable-next-line no-console
      console.log(`flight ${i}: lower-foot clearance ${(lo * 100).toFixed(1)} cm`);
      expect(lo, `flight ${i}: both feet airborne`).toBeGreaterThan(0.06);
    }
    // A sustained airborne total across the motion, not one-frame blips.
    let airborneFrames = 0;
    for (let i = 0; i < rec.frames.length; i += 1) {
      if (Math.min(lY[i]!, rY[i]!) - floor > 0.05) airborneFrames += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`travel run: ${airborneFrames} airborne frames of ${rec.frames.length}`);
    expect(airborneFrames, 'sustained flight phases').toBeGreaterThanOrEqual(12);
  });

  it('touchdown ABSORPTION: the landing knee yields ~8-12° past the stance-drive knee within ~150 ms of contact, then recoils', () => {
    const { rec, resolved } = sampleTravelRun();
    const arrive = phaseClock(resolved);
    // Steps 1 (lands L) and 2 (lands R) — mid-motion landings, entry/exit-free.
    for (const [step, side] of [[1, 'L'], [2, 'R']] as const) {
      const contactMs = arrive[4 * step]!; // touchdown arrival
      const absorbMs = arrive[4 * step + 1]!;
      const driveMs = arrive[4 * step + 2]!;
      expect(absorbMs - contactMs, 'absorption sub-phase sits at the engine floor (~150 ms) after contact').toBeLessThanOrEqual(160);
      // The stance-drive knee the yield is measured against: the resolved
      // (clamped) drive-keyframe target — the value the leg recoils to.
      const driveKnee = resolved.keyframes[4 * step + 2]!.targets.find(
        (t) => t.joint === `${side}_Leg` && t.motion === 'kneeFlexion',
      )!.clampedDegrees;
      const knees = kneeSeries(rec, side);
      const at = (t: number) => knees[rec.frames.indexOf(frameAt(rec, t))]!;
      const kneeAtContact = at(contactMs);
      const kneeAtToeOff = at(driveMs);
      let peak = -Infinity;
      let peakMs = 0;
      for (let i = 0; i < rec.frames.length; i += 1) {
        const t = rec.frames[i]!.tMs;
        if (t < contactMs || t > contactMs + 170) continue;
        if (knees[i]! > peak) {
          peak = knees[i]!;
          peakMs = t;
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `step ${step} (${side}): knee ${kneeAtContact.toFixed(1)}° at contact → peak ${peak.toFixed(1)}° at +${(peakMs - contactMs).toFixed(0)} ms → drive ${driveKnee.toFixed(1)}° (toe-off ${kneeAtToeOff.toFixed(1)}°)`,
      );
      // The knee flexes UNDER LOAD after contact (yield), …
      expect(peak - kneeAtContact, `${side} knee yields after contact`).toBeGreaterThan(12);
      // …peaks ~8-12° beyond the stance-drive knee, …
      expect(peak - driveKnee, `${side} yield exceeds the drive knee`).toBeGreaterThan(6);
      expect(peak - driveKnee, `${side} yield stays physiologic`).toBeLessThan(16);
      // …within ~150 ms of contact (the engine's keyframe floor)…
      expect(peakMs - contactMs, `${side} yield peaks within ~150 ms`).toBeLessThanOrEqual(160);
      // …and RECOILS out of the yield before toe-off.
      expect(kneeAtToeOff, `${side} knee recoils into the drive`).toBeLessThan(peak - 5);
    }
  });

  it('the GROUNDED pelvis arc sits in the running band (~7-9 cm) with no hard snap at touchdown', () => {
    const { rec, resolved } = sampleTravelRun();
    const ys = rec.frames.map((f) => f.root.translateM[1]);
    // Grounded (stance-window) excursion — the running COM vertical the roadmap
    // calibrates (~7-9 cm): min stance dip → max stance height across windows.
    let gLo = Infinity;
    let gHi = -Infinity;
    for (const [i, f] of rec.frames.entries()) {
      const inStance = resolved.contacts!.some((c) => f.tMs >= c.fromMs! && f.tMs <= c.toMs!);
      if (!inStance) continue;
      gLo = Math.min(gLo, ys[i]!);
      gHi = Math.max(gHi, ys[i]!);
    }
    const groundedP2p = gHi - gLo;
    let maxStep = 0;
    for (let i = 1; i < ys.length; i += 1) maxStep = Math.max(maxStep, Math.abs(ys[i]! - ys[i - 1]!));
    const p2p = Math.max(...ys) - Math.min(...ys);
    // eslint-disable-next-line no-console
    console.log(
      `travel run: grounded pelvis arc ${(groundedP2p * 100).toFixed(1)} cm (whole-motion ${(p2p * 100).toFixed(1)} cm incl. flight); max per-frame step ${(maxStep * 100).toFixed(2)} cm @120 Hz`,
    );
    expect(groundedP2p, 'grounded vertical in the running band').toBeGreaterThan(0.05);
    expect(groundedP2p, 'grounded vertical in the running band').toBeLessThan(0.11);
    // Whole-motion excursion adds the ballistic flight rise on top.
    expect(p2p, 'vertical excursion stays believable').toBeLessThan(0.22);
    expect(maxStep, 'no single-frame vertical snap at touchdown').toBeLessThan(0.035);
  });

  it('paced travel: a faster run travels farther', () => {
    const normal = sampleTravelRun().rec;
    const fast = sampleTravelRun({ speed: 1.4 }).rec;
    // eslint-disable-next-line no-console
    console.log(`travel run: normal ${hipsDz(normal).toFixed(2)} m vs fast ${hipsDz(fast).toFixed(2)} m`);
    expect(hipsDz(fast), 'faster travels farther').toBeGreaterThan(hipsDz(normal) + 0.1);
  });
});

describe('buildRun — the in-place cycle carries the same absorption authoring', () => {
  it('each landing authors touchdown → absorb (knee + hip yield past the drive) → drive → flight', () => {
    const m = buildRun();
    expect(m.keyframes.length).toBe(8); // 2 steps × 4 keyframes
    const deg = (kf: (typeof m.keyframes)[number], joint: string, motion: string) =>
      kf.targets!.find((t) => t.joint === joint && t.motion === motion)!.targetDegrees;
    for (const [base, side] of [[0, 'R'], [4, 'L']] as const) {
      const [touchdown, absorb, drive, flight] = m.keyframes.slice(base, base + 4);
      // Touchdown reaches near-extended; the absorption YIELDS past the drive.
      expect(deg(absorb!, `${side}_Leg`, 'kneeFlexion') - deg(touchdown!, `${side}_Leg`, 'kneeFlexion')).toBeGreaterThan(20);
      // Authored deeper than the physiologic ~10° so the TRAVEL run's plant-
      // IK'd measured yield lands in the ~8-12° band (see the builder note).
      const extraKnee = deg(absorb!, `${side}_Leg`, 'kneeFlexion') - deg(drive!, `${side}_Leg`, 'kneeFlexion');
      const extraHip = deg(absorb!, `${side}_UpLeg`, 'hipFlexion') - deg(drive!, `${side}_UpLeg`, 'hipFlexion');
      expect(extraKnee, `${side} absorption knee yield`).toBeGreaterThanOrEqual(14);
      expect(extraKnee, `${side} absorption knee yield`).toBeLessThanOrEqual(18);
      expect(extraHip, `${side} absorption hip yield`).toBeGreaterThanOrEqual(6);
      // Grounding: touchdown/absorb/drive planted, flight floating with rise.
      expect(touchdown!.stance).toBe('planted');
      expect(absorb!.stance).toBe('planted');
      expect(drive!.stance).toBe('planted');
      expect(flight!.stance).toBe('floating');
      // Authored as a raw ABSOLUTE flight-apex root height (travel sugar is a
      // DELTA step per AI-SUGAR-01, so the seeded heights author raw roots).
      expect(flight!.root?.translateM?.[1]).toBeGreaterThan(0);
    }
  });
});
