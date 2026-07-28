/**
 * RUN GROUNDING PARITY (roadmap 4.3) — the run gets the walk's polish:
 *
 *   1. TOUCHDOWN ABSORPTION: each landing runs touchdown → absorption →
 *      re-extension into TOE-OFF. The landing knee YIELDS ~20-25° from its
 *      value AT CONTACT (the loading response), then re-extends before leaving
 *      the ground — authored keyframes in the run cycle, measured here on the
 *      rig. The third keyframe is toe-off, not a mid-stance "drive": the run's
 *      whole propulsive hip sweep has to fall INSIDE the stance window or the
 *      travel derivation never measures it (see runSpatiotemporal.test.ts).
 *   2. FOOT-PLANT CONTACTS: buildTravelRun pins each stance foot for its
 *      touchdown→toe-off window (the walk's contact machinery, on the run's own
 *      phase timing); FLIGHT phases carry no contact by definition — both feet
 *      are measurably airborne mid-flight, never pinned.
 *   3. buildTravelRun — the running sibling of buildTravelWalk: footDrivenTravel
 *      over the run cycle, with the derivation COASTING at the last grounded
 *      advance rate through each flight gap (no grounded reference, but the
 *      body is a projectile) and resuming at touchdown
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

/** buildTravelRun's leading INITIATION keyframe — the entry that brings the body
 *  into running form before the first contact. Every per-step index below is
 *  offset by it; without the offset these read one keyframe early and measure the
 *  entry as if it were a stride (it collapsed the first step's absorption yield
 *  from ~25° to 0.4°, which is how this was caught). */
const RUN_ENTRY_KEYFRAMES = 1;

describe('buildTravelRun — shape of the plan', () => {
  it('is the run cycle ×2 + a closing touchdown — planted, non-looping, foot-driven, contact-pinned', () => {
    const m = buildTravelRun();
    // [0] initiation · 4 steps × (touchdown, absorb, toe-off, flight) · closing touchdown.
    // The entry exists so the arms reach the run's ~85° carry BEFORE the first
    // contact instead of snapping into it (see runInitiationKeyframe).
    expect(m.keyframes.length).toBe(18);
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
      const f = frameAt(rec, arrive[RUN_ENTRY_KEYFRAMES + 4 * i + 3]!);
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

  it('touchdown ABSORPTION: the landing knee yields ~20° from CONTACT, then re-extends into toe-off', () => {
    const { rec, resolved } = sampleTravelRun();
    const arrive = phaseClock(resolved);
    // Steps 1 (lands L) and 2 (lands R) — mid-motion landings, entry/exit-free.
    for (const [step, side] of [[1, 'L'], [2, 'R']] as const) {
      const contactMs = arrive[RUN_ENTRY_KEYFRAMES + 4 * step]!; // touchdown arrival
      const absorbMs = arrive[RUN_ENTRY_KEYFRAMES + 4 * step + 1]!;
      const toeOffMs = arrive[RUN_ENTRY_KEYFRAMES + 4 * step + 2]!; // the PUSH keyframe closes the stance
      expect(absorbMs - contactMs, 'absorption sub-phase sits at the engine floor (~150 ms) after contact').toBeLessThanOrEqual(160);
      const knees = kneeSeries(rec, side);
      const at = (t: number) => knees[rec.frames.indexOf(frameAt(rec, t))]!;
      const kneeAtContact = at(contactMs);
      const kneeAtToeOff = at(toeOffMs);
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
        `step ${step} (${side}): knee ${kneeAtContact.toFixed(1)}° at contact → peak ${peak.toFixed(1)}° at +${(peakMs - contactMs).toFixed(0)} ms → toe-off ${kneeAtToeOff.toFixed(1)}°`,
      );
      // THE REFERENCE IS THE KNEE AT CONTACT, and that is not a detail. This gate
      // used to measure the yield against the third keyframe's knee, back when
      // that keyframe was a mid-stance "drive" the leg recoiled to. It is now
      // TOE-OFF — the knot that closes the stance window, without which the run's
      // propulsive sweep never reaches the travel derivation. Measured against
      // toe-off the same healthy yield reads ~25° and would trip a band written
      // for a mid-stance reference; measured from contact it is the loading
      // response itself: ~20-25° of knee flexion under load in running
      // [Novacheck; Dugan & Bhat].
      expect(peak - kneeAtContact, `${side} loading-response yield`).toBeGreaterThan(15);
      expect(peak - kneeAtContact, `${side} loading-response stays physiologic`).toBeLessThan(32);
      // …within ~150 ms of contact (the engine's keyframe floor)…
      expect(peakMs - contactMs, `${side} yield peaks within ~150 ms`).toBeLessThanOrEqual(160);
      // …and RE-EXTENDS out of the yield before leaving the ground: a runner does
      // not toe off at their deepest stance flexion.
      expect(kneeAtToeOff, `${side} knee re-extends into toe-off`).toBeLessThan(peak - 10);
      expect(kneeAtToeOff, `${side} toe-off knee stays physiologic`).toBeGreaterThan(0);
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
  it('each landing authors touchdown → absorb → TOE-OFF → flight, with the stance sweep inside the stance', () => {
    const m = buildRun();
    expect(m.keyframes.length).toBe(8); // 2 steps × 4 keyframes
    const deg = (kf: (typeof m.keyframes)[number], joint: string, motion: string) =>
      kf.targets!.find((t) => t.joint === joint && t.motion === motion)!.targetDegrees;
    for (const [base, side] of [[0, 'R'], [4, 'L']] as const) {
      const [touchdown, absorb, push, flight] = m.keyframes.slice(base, base + 4);
      const knee = (kf: (typeof m.keyframes)[number]) => deg(kf, `${side}_Leg`, 'kneeFlexion');
      const hip = (kf: (typeof m.keyframes)[number]) => deg(kf, `${side}_UpLeg`, 'hipFlexion');
      // LOADING RESPONSE: the knee flexes UNDER LOAD after contact. Running's is
      // ~20-25° [Novacheck], measured from the knee AT CONTACT — which is the
      // only reference that survives, because the pose the knee recoils TO is
      // now toe-off (see below) rather than a mid-stance "drive" knot.
      expect(knee(absorb!) - knee(touchdown!), `${side} loading-response knee yield`).toBeGreaterThanOrEqual(18);
      expect(knee(absorb!) - knee(touchdown!), `${side} loading-response knee yield`).toBeLessThanOrEqual(32);
      expect(hip(absorb!) - hip(touchdown!), `${side} hip yields under load too`).toBeLessThan(0);
      // TOE-OFF is a KNOT, and it is the one that closes the stance window. The
      // run's speed is (stance sweep)/(ground contact time), so the whole sweep
      // has to live between touchdown and this keyframe: if the hip extension
      // shows up only in FLIGHT (as it once did), the derivation never measures
      // it and the run travels at ~1/3 speed. Guard both halves of the sweep.
      expect(hip(touchdown!), `${side} touchdown reaches AHEAD`).toBeGreaterThan(10);
      expect(hip(push!), `${side} toe-off trails BEHIND`).toBeLessThan(0);
      expect(hip(touchdown!) - hip(push!), `${side} stance hip sweep`).toBeGreaterThan(25);
      // …and the knee RECOILS out of the yield before it (a run does not leave
      // the ground at its deepest stance flexion).
      expect(knee(push!), `${side} knee re-extends into toe-off`).toBeLessThan(knee(absorb!) - 8);
      // Grounding: touchdown/absorb/toe-off planted, flight floating with rise.
      expect(touchdown!.stance).toBe('planted');
      expect(absorb!.stance).toBe('planted');
      expect(push!.stance).toBe('planted');
      expect(flight!.stance).toBe('floating');
      // The flight apex is the highest authored knot of the step — the arc rises
      // out of toe-off. (Authored as a raw ABSOLUTE root height: travel sugar is
      // a DELTA step per AI-SUGAR-01, so the seeded heights author raw roots.)
      expect(flight!.root!.translateM![1]).toBeGreaterThan(push!.root!.translateM![1]!);
      expect(flight!.root!.translateM![1]).toBeGreaterThan(touchdown!.root!.translateM![1]!);
    }
  });
});

describe('the run ENTERS running form instead of snapping into it', () => {
  // The complaint this fixes was "the arm swings are awkward", and the arms were
  // where it showed: the run's first keyframe used to BE a touchdown, so the body
  // went from standing to full stride in one knot. The elbows carry ~85° through
  // a run and start straight at the sides, so that whole excursion landed inside
  // the first keyframe — measured on the rig, -1° to 81° in 117 ms, a peak of
  // 1041°/s. Nothing refused it (the ballistic cap is 2000°/s); it just read as a
  // flinch. The steady-state swing was already fine, which is why the fix is an
  // entry and not a re-authoring of the stride.
  it('brings the elbows into the carry without a snap', () => {
    const { rec } = sampleTravelRun();
    const frames = rec.frames;
    const elbow = (i: number) => frames[i]!.angles?.R_Forearm?.elbowFlexion;

    const first = elbow(0);
    expect(typeof first, 'R elbow measured').toBe('number');
    expect(Math.abs(first!), 'the run starts from straight arms').toBeLessThan(15);

    let peak = 0;
    for (let i = 1; i < frames.length; i += 1) {
      const a = elbow(i - 1);
      const b = elbow(i);
      const dt = (frames[i]!.tMs - frames[i - 1]!.tMs) / 1000;
      if (typeof a === 'number' && typeof b === 'number' && dt > 0) {
        peak = Math.max(peak, Math.abs(b - a) / dt);
      }
    }
    // Was 1041°/s with no entry; 444°/s with it. The bound is set between the two
    // so this fails if the initiation is dropped, and does not pin the exact
    // easing — a smoother entry is free to go lower.
    expect(peak, `peak R elbow angular speed ${peak.toFixed(0)}°/s`).toBeLessThan(700);
  });

  it('is in the carry BEFORE the first contact, not during it', () => {
    const { rec, resolved } = sampleTravelRun();
    const arrive = phaseClock(resolved);
    const firstContactMs = arrive[RUN_ENTRY_KEYFRAMES]!;
    const f = frameAt(rec, firstContactMs);
    const elbow = f.angles?.R_Forearm?.elbowFlexion ?? 0;
    // The run carries ~85°; arriving at contact still near-straight is the defect.
    expect(elbow, 'elbow is already carried at first contact').toBeGreaterThan(60);
  });
});
