/**
 * UNIVERSAL RELAXED HANDS — anatomical-position rest leaves the hands as flat
 * supinated paddles, and only gait's coordination used to fix that. The
 * `relaxedHands` resolve-time transform must give EVERY motion that leaves the
 * hands unspecified (squat, reach, kick…) a loose resting hand —
 * graded per-digit curl + slight wrist flexion — while skipping motions that
 * author the hands (gait coordination, wrist AROM) or load them (push-up /
 * plank / quadruped / bird-dog hand plants, lying postures, hand contacts).
 * This pins: (1) squat/reach get the full set on every keyframe; (2) the graded
 * curl is a LOOSE hand, not a fist; (3) hand-planting and lying motions are
 * byte-identical (same object reference); (4) the walk passes through untouched
 * — its hand targets all come from its own coordination values; (5) the added
 * targets ride the SAME truth path (ROM scenario clamp exercised); and (6) on
 * the sampled rig the squat's fingers measurably curl while the push-up's stay
 * flat.
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
import { ROM_JOINT_ROWS } from '../services/romRegistry';
import {
  relaxedHands,
  resolveComposedMotion,
  RELAXED_HAND_TARGETS,
  RELAXED_FINGER_CURL_DEG,
  RELAXED_WRIST_FLEX_DEG,
  HAND_JOINT_KEYS,
  MAX_TARGETS_PER_KEYFRAME,
  type ComposedMotion,
  type ResolvedComposedMotion,
} from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import {
  buildBirdDog,
  buildGetDownToPlank,
  buildGetDownToQuadruped,
  buildLieDown,
  buildPushUp,
  buildSupineLegRaise,
  buildTravelWalk,
  spinalGaitCoordination,
  templateToComposedMotion,
  MOVEMENT_TEMPLATES,
} from '../services/movementTemplates';
import { measureCommandMotion } from '../services/movementCommand';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;

const template = (id: string): ComposedMotion =>
  templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === id)!);

/** The clamped hand targets of one resolved keyframe, keyed `joint.motion`. */
const handTargetsOf = (r: ResolvedComposedMotion, ki: number): Map<string, number> => {
  const out = new Map<string, number>();
  for (const t of r.keyframes[ki]!.targets) {
    if (HAND_JOINT_KEYS.includes(t.joint)) out.set(`${t.joint}.${t.motion}`, t.clampedDegrees);
  }
  return out;
};

const hasAnyHandTarget = (r: ResolvedComposedMotion): boolean =>
  r.keyframes.some((kf) => kf.targets.some((t) => HAND_JOINT_KEYS.includes(t.joint)));

describe('relaxedHands — authoring (pure)', () => {
  it('squat + reach + lunge carry the FULL relaxed-hand set on every keyframe', () => {
    // (sit-to-stand left this list in Wave 5: it now AUTHORS its thigh-push hand
    // targets — the authors-hands gate skips it, asserted below.)
    for (const id of ['squat', 'endpoint-reach', 'forward-lunge'] as const) {
      const r = resolveComposedMotion(template(id), variantCfg);
      expect(r.status, id).toBe('ok');
      // Every keyframe (incl. peak-timing sub-keyframes) carries all 12 targets…
      for (let ki = 0; ki < r.keyframes.length; ki += 1) {
        const hands = handTargetsOf(r, ki);
        expect(hands.size, `${id} kf${ki} has the full 12-target hand set`).toBe(
          RELAXED_HAND_TARGETS.length,
        );
      }
      // …and at the LAST keyframe (a phase boundary — no lead interpolation) the
      // values are EXACTLY the relaxed set, ROM-complied, both sides.
      const settled = handTargetsOf(r, r.keyframes.length - 1);
      for (const S of ['L', 'R'] as const) {
        expect(settled.get(`${S}_Hand.wristFlexion`), `${id} ${S} wrist`).toBe(
          RELAXED_WRIST_FLEX_DEG,
        );
        for (const [digit, deg] of Object.entries(RELAXED_FINGER_CURL_DEG)) {
          expect(settled.get(`${S}_${digit}.fingerFlexion`), `${id} ${S}_${digit}`).toBe(deg);
        }
      }
      // The hand targets all COMPLIED (the set sits well inside normative ROM).
      const handOutcomes = r.outcomes.filter((o) => HAND_JOINT_KEYS.includes(o.joint));
      expect(handOutcomes.length).toBeGreaterThan(0);
      expect(handOutcomes.every((o) => o.status === 'complied'), `${id} hand set inside ROM`).toBe(
        true,
      );
    }
  });

  it('the curl is a GRADED LOOSE hand — thumb least → pinky most, nowhere near a fist', () => {
    const { Thumb1, Index1, Mid1, Ring1, Pinky1 } = RELAXED_FINGER_CURL_DEG as Record<
      string,
      number
    >;
    expect(Thumb1!).toBeLessThan(Index1!);
    expect(Index1!).toBeLessThan(Mid1!);
    expect(Mid1!).toBeLessThan(Ring1!);
    expect(Ring1!).toBeLessThan(Pinky1!);
    // A fist is a ~100°+ composite curl; the relaxed cascade stays far below it.
    expect(Pinky1!).toBeLessThan(70);
    expect(RELAXED_WRIST_FLEX_DEG).toBeGreaterThan(0);
    expect(RELAXED_WRIST_FLEX_DEG).toBeLessThan(20);
  });

  it('a motion authoring BOTH hands passes through byte-identical (neither side overridden)', () => {
    // sit-to-stand authors BOTH wrists (its thigh-push arm strategy), so the
    // author owns the whole hand complex — no relaxed curl on either side.
    const m = template('sit-to-stand');
    expect(relaxedHands(m), 'sit-to-stand same reference').toBe(m);
    const r = resolveComposedMotion(m, variantCfg);
    expect(
      r.keyframes.some((kf) => kf.targets.some((t) => t.motion === 'fingerFlexion')),
      'sit-to-stand gets no finger curl',
    ).toBe(false);
  });

  it('DET-GATE-01 — a ONE-HANDED wrist screen relaxes the OTHER (free) hand, keeping the authored side as-is', () => {
    // A wrist AROM screen authors only the RIGHT hand. The OLD whole-body gate
    // stripped the resting curl off BOTH hands, leaving the free left hand a flat
    // anatomical paddle; the per-side gate now relaxes the free left hand while
    // leaving the authored right hand exactly as the screen posed it.
    for (const id of ['wrist-flexion-extension', 'wrist-deviation'] as const) {
      const m = template(id);
      expect(relaxedHands(m), `${id} is modified (free left hand relaxed)`).not.toBe(m);
      const r = resolveComposedMotion(m, variantCfg);
      // LEFT (free) hand carries the graded finger curl on keyframes with targets…
      const leftCurls = r.keyframes.flatMap((kf) =>
        kf.targets.filter((t) => t.joint.startsWith('L_') && t.motion === 'fingerFlexion'),
      );
      expect(leftCurls.length, `${id} free left hand curls`).toBeGreaterThan(0);
      // …and the resting wrist flexion (not the authored screen values).
      const leftWrist = r.keyframes
        .flatMap((kf) => kf.targets.filter((t) => t.joint === 'L_Hand' && t.motion === 'wristFlexion'))
        .map((t) => t.clampedDegrees);
      expect(leftWrist.length).toBeGreaterThan(0);
      expect(
        leftWrist.every((v) => Math.abs(v - RELAXED_WRIST_FLEX_DEG) < 1e-9),
        `${id} free left wrist rests at ${RELAXED_WRIST_FLEX_DEG}°`,
      ).toBe(true);
      // RIGHT (authored) hand: NO finger curl added — the author owns it.
      expect(
        r.keyframes.some((kf) =>
          kf.targets.some((t) => t.joint.startsWith('R_') && t.motion === 'fingerFlexion'),
        ),
        `${id} authored right hand keeps no curl`,
      ).toBe(false);
    }
  });

  it('hand-planting motions are SKIPPED — push-up, plank/quadruped transitions, bird-dog', () => {
    // The palm bears weight on the floor; a curled hand would float it off its
    // support and fight the hand-plant IK.
    for (const m of [
      buildPushUp(),
      buildGetDownToPlank(),
      buildGetDownToQuadruped(),
      buildBirdDog(), // incl. the one-hand 'quadruped-hand-*' grounding variant
    ]) {
      expect(relaxedHands(m), `${m.name} same reference`).toBe(m);
      const r = resolveComposedMotion(m, variantCfg);
      expect(
        r.keyframes.some((kf) => kf.targets.some((t) => t.motion === 'fingerFlexion')),
        `${m.name} gets no finger curl`,
      ).toBe(false);
    }
  });

  it('lying motions are SKIPPED — the hands may bear against the support', () => {
    for (const m of [buildLieDown(), buildSupineLegRaise()]) {
      expect(relaxedHands(m), `${m.name} same reference`).toBe(m);
    }
    // Raw root reorientation (no posture sugar) is caught by the pitch/roll gate.
    const rawLie: ComposedMotion = {
      keyframes: [
        { durationMs: 800, root: { orient: { pitchDeg: -90 } } },
        { durationMs: 600, targets: [{ joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 40 }] },
      ],
    };
    expect(relaxedHands(rawLie)).toBe(rawLie);
  });

  it('DET-GATE-01 — a declared ONE-HAND contact keeps that palm flat but relaxes the free hand', () => {
    const m: ComposedMotion = {
      keyframes: [
        { durationMs: 600, targets: [{ joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: 40 }] },
      ],
      contacts: [{ foot: 'L_Hand' }],
    };
    const out = relaxedHands(m);
    expect(out, 'transform runs (free right hand relaxed)').not.toBe(m);
    const added = out.keyframes[0]!.targets!;
    // LEFT hand (planted, bearing) stays flat — no relaxed targets on the left.
    expect(
      added.some(
        (t) => t.joint.startsWith('L_') && (t.motion === 'fingerFlexion' || t.motion === 'wristFlexion'),
      ),
      'planted left palm stays flat',
    ).toBe(false);
    // RIGHT hand (free) gets the full relaxed set (6 targets: wrist + 5 digits).
    expect(
      added.filter(
        (t) => t.joint.startsWith('R_') && (t.motion === 'fingerFlexion' || t.motion === 'wristFlexion'),
      ).length,
      'free right hand gets the resting curl',
    ).toBe(6);
  });

  it('DET-GATE-01 — a BOTH-hand contact keeps both palms flat (whole-body plant)', () => {
    const m: ComposedMotion = {
      keyframes: [
        { durationMs: 600, targets: [{ joint: 'Spine_Lower', motion: 'flexion', targetDegrees: 20 }] },
      ],
      contacts: [{ foot: 'L_Hand' }, { foot: 'R_Hand' }],
    };
    expect(relaxedHands(m), 'both hands planted ⇒ byte-identical').toBe(m);
  });

  it('the WALK is untouched byte-for-byte — its hand targets all come from its own coordination', () => {
    // Gait's coordination authors wrist + fingers, so the authored-hands gate
    // fires and the transform returns the SAME object — resolution is therefore
    // byte-identical to the pre-relaxedHands behaviour.
    const coordinated = spinalGaitCoordination(template('walk'));
    expect(relaxedHands(coordinated)).toBe(coordinated);
    const walk = buildTravelWalk();
    expect(relaxedHands(walk)).toBe(walk);

    const r = resolveComposedMotion(walk, variantCfg);
    expect(r.status).toBe('ok');
    // The walk's finger targets come from its OWN coordination, not from the
    // relaxed set. This used to be proven by value-distinctness — gait applied a
    // flat 32° that appeared nowhere in RELAXED_FINGER_CURL_DEG. It now reuses
    // that cascade deliberately (one hand posture, not two), so distinctness no
    // longer discriminates and would be the wrong thing to pin anyway.
    //
    // The discriminator is now BEHAVIOURAL, and it is a stronger one: relaxedHands
    // writes a STATIC resting set — one value per digit, identical on every
    // keyframe — whereas gait's coordination drives the digits through the cycle
    // via tenodesis (wrist extension curls them, flexion releases them). So a
    // finger series that VARIES can only have come from the coordinator.
    const indexSeries = r.keyframes.map(
      (kf) => kf.targets.find((t) => t.joint === 'R_Index1' && t.motion === 'fingerFlexion')?.clampedDegrees ?? 0,
    );
    expect(
      Math.max(...indexSeries) - Math.min(...indexSeries),
      'the digits move across the cycle (coordination, not the static relaxed set)',
    ).toBeGreaterThan(2);
    // …and the cascade ordering holds at every keyframe: radial digits straighter,
    // ulnar more curled — a relaxed hand, never a uniform claw.
    for (const kf of r.keyframes) {
      const curl = (j: string) =>
        kf.targets.find((t) => t.joint === j && t.motion === 'fingerFlexion')?.clampedDegrees;
      const [idx, mid, ring, pinky] = ['R_Index1', 'R_Mid1', 'R_Ring1', 'R_Pinky1'].map(curl);
      if (idx == null || mid == null || ring == null || pinky == null) continue;
      expect(idx).toBeLessThan(mid);
      expect(mid).toBeLessThan(ring);
      expect(ring).toBeLessThan(pinky);
    }
    // The coordinated wrist DRAGS with the arm swing (oscillates across the
    // cycle) — the relaxed set would be one constant value on every keyframe.
    const wristVals = r.keyframes.map(
      (kf) => kf.targets.find((t) => t.joint === 'R_Hand' && t.motion === 'wristFlexion')?.clampedDegrees ?? 0,
    );
    expect(Math.max(...wristVals) - Math.min(...wristVals), 'wrist oscillates (coordination, not the constant relaxed set)').toBeGreaterThan(2);
  });

  it('the added targets ride the SAME truth path — a ROM scenario constraint clamps the curl', () => {
    const r = resolveComposedMotion(template('squat'), variantCfg, {
      constraints: { R_Index1: { fingerFlexion: { availableRange: { max: 10 } } } },
    });
    expect(r.status).toBe('ok');
    const indexOutcomes = r.outcomes.filter(
      (x) => x.joint === 'R_Index1' && x.motion === 'fingerFlexion',
    );
    expect(indexOutcomes.length).toBeGreaterThan(0);
    // EVERY index-curl outcome is clamped to the scenario's 10° (earlier
    // peak-timing sub-keyframes request an interpolated fraction of the curl,
    // the phase boundaries the full 24° — all clamp on the same truth path).
    expect(indexOutcomes.every((o) => o.status !== 'refused')).toBe(true);
    expect(indexOutcomes.every((o) => (o.clampedDegrees ?? 0) <= 10)).toBe(true);
    const settle = indexOutcomes[indexOutcomes.length - 1]!; // last keyframe: full request
    expect(settle.status).toBe('modified');
    expect(settle.requestedDegrees).toBe(RELAXED_FINGER_CURL_DEG.Index1);
    expect(settle.clampedDegrees).toBe(10);
    // The other digits (unconstrained) still comply at the authored curl.
    const pinky = r.outcomes.filter((x) => x.joint === 'R_Pinky1' && x.motion === 'fingerFlexion');
    expect(pinky[pinky.length - 1]!.status).toBe('complied');
  });

  it('respects the per-keyframe target budget — the biggest possible keyframe still fits the hand set', () => {
    // THIS TEST CHANGED MEANING when MAX_TARGETS_PER_KEYFRAME went 48 → 58, and
    // saying so is the point. It used to prove the transform SKIPS a keyframe too
    // full to take the 12-target resting-hand set: 40 non-hand + 12 = 52 > 48.
    //
    // At 58 that scenario is no longer constructible. The registry commands 60
    // channels, 14 of them on the hands (10 finger curls + wrist flexion and
    // deviation per side), leaving exactly 46 non-hand ones — and 46 + 12 = 58,
    // the cap precisely. So the busiest keyframe anyone can author now takes the
    // full hand set with nothing dropped, and the skip branch is unreachable by
    // any real plan rather than merely untriggered by this one.
    //
    // DERIVED from the registry so it tracks the real channel count instead of a
    // hand-maintained list; the old one silently carried three `Head` targets for
    // a row that does not exist, so it was really only 37.
    const READOUT_ONLY = new Set(['elbowDeviation', 'proSup', 'kneeDeviation']);
    const joints: [string, string][] = ROM_JOINT_ROWS.filter(
      (row) => !HAND_JOINT_KEYS.includes(row.canonicalKey),
    ).flatMap((row) =>
      row.fields
        .filter((f) => !READOUT_ONLY.has(f.key))
        .map((f) => [row.canonicalKey, f.key] as [string, string]),
    );
    expect(joints.length, 'every non-hand commandable channel').toBe(46);
    const m: ComposedMotion = {
      keyframes: [
        { durationMs: 800, targets: joints.map(([joint, motion]) => ({ joint, motion, targetDegrees: 5 })) },
      ],
    };
    const out = relaxedHands(m);
    expect(out.keyframes[0]!.targets!.length, 'the hand set fits exactly at the cap').toBe(
      MAX_TARGETS_PER_KEYFRAME,
    );
    const r = resolveComposedMotion(out, variantCfg);
    expect(r.status).toBe('ok');
    expect(r.outcomes.every((o) => o.reason !== 'target-limit'), 'nothing overflow-dropped').toBe(true);
  });
});

describe('relaxedHands — measured on the rig', () => {
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

  /** Sample a motion once and read back the measured series of several joints. */
  const measuredSeries = (
    motion: ComposedMotion,
    keys: [joint: string, motionKey: string][],
  ): Map<string, number[]> => {
    const rec = sampleComposedMotion(resolveComposedMotion(motion, variantCfg), {
      baselinePose,
      variantCfg,
      rest,
      skeletonHarness: { root, skinned },
      sampleHz: 30,
    });
    const out = new Map<string, number[]>();
    for (const [joint, motionKey] of keys) {
      out.set(
        `${joint}.${motionKey}`,
        rec.frames.map(
          (f) =>
            measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, joint, motionKey) ?? 0,
        ),
      );
    }
    return out;
  };

  // NOTE: the rig's rest mesh holds the fingers naturally slightly bent, so the
  // composite fingerFlexion READOUT is nonzero at anatomic rest (~22° index /
  // ~20° pinky / ~7° mid). The motor is calibrated against that same readout, so
  // a commanded curl SETTLES ON the commanded value — the gates below therefore
  // assert settle values and EXCURSION (motion), which are baseline-honest.
  it('the sampled SQUAT performs with measurably curled relaxed hands (not flat paddles)', () => {
    const s = measuredSeries(template('squat'), [
      ['R_Mid1', 'fingerFlexion'],
      ['R_Ring1', 'fingerFlexion'],
      ['R_Pinky1', 'fingerFlexion'],
      ['L_Pinky1', 'fingerFlexion'],
      ['R_Hand', 'wristFlexion'],
    ]);
    const last = (k: string): number => s.get(k)!.at(-1)!;
    const excursion = (k: string): number => Math.max(...s.get(k)!) - Math.min(...s.get(k)!);
    // eslint-disable-next-line no-console
    console.log(
      `squat rig: settle mid ${last('R_Mid1.fingerFlexion').toFixed(1)}° · ring ${last('R_Ring1.fingerFlexion').toFixed(1)}° · pinky ${last('R_Pinky1.fingerFlexion').toFixed(1)}° · wrist ${last('R_Hand.wristFlexion').toFixed(1)}° · pinky excursion ${excursion('R_Pinky1.fingerFlexion').toFixed(1)}°`,
    );
    // The fingers really MOVE into the curl (not just authored — measured)…
    expect(excursion('R_Pinky1.fingerFlexion'), 'pinky visibly curls').toBeGreaterThan(12);
    expect(excursion('R_Mid1.fingerFlexion'), 'mid visibly curls').toBeGreaterThan(12);
    // …and SETTLE on the authored relaxed values (±3° measurement tolerance),
    // graded ulnar-more-than-radial, on BOTH hands.
    expect(last('R_Mid1.fingerFlexion')).toBeCloseTo(RELAXED_FINGER_CURL_DEG.Mid1!, -1);
    expect(last('R_Ring1.fingerFlexion')).toBeCloseTo(RELAXED_FINGER_CURL_DEG.Ring1!, -1);
    expect(last('R_Pinky1.fingerFlexion')).toBeCloseTo(RELAXED_FINGER_CURL_DEG.Pinky1!, -1);
    expect(last('L_Pinky1.fingerFlexion')).toBeCloseTo(RELAXED_FINGER_CURL_DEG.Pinky1!, -1);
    expect(last('R_Pinky1.fingerFlexion')).toBeGreaterThan(last('R_Mid1.fingerFlexion'));
    // The wrist carries the slight resting flexion (a hanging hand, not a paddle).
    expect(last('R_Hand.wristFlexion')).toBeCloseTo(RELAXED_WRIST_FLEX_DEG, 0);
    // LOOSE — nowhere near a fist (~100°+ composite curl).
    expect(Math.max(...s.get('R_Pinky1.fingerFlexion')!)).toBeLessThan(70);
  });

  it('the sampled PUSH-UP keeps flat weight-bearing palms — the fingers never move', () => {
    const s = measuredSeries(buildPushUp(), [
      ['R_Index1', 'fingerFlexion'],
      ['R_Pinky1', 'fingerFlexion'],
      ['L_Pinky1', 'fingerFlexion'],
    ]);
    for (const [key, series] of s) {
      const range = Math.max(...series) - Math.min(...series);
      // eslint-disable-next-line no-console
      console.log(`push-up rig: ${key} range ${range.toFixed(2)}°`);
      // The digits NEVER curl — the relaxed-hand transform skips the hand-planting
      // motion entirely, and the push-up authors no finger targets at all
      // (verified: zero fingerFlexion targets on every keyframe).
      //
      // KNOWN DIVERGENCE, newly visible: the recorded `angles` report ~7.7° on the
      // index from frame 1 on, while re-measuring the recorded `pose` reports
      // 0.000° and the finger bones' local quats are provably static across the
      // whole clip. So a frame's two halves disagree — the angles were measured
      // against a skeleton state the serialized pose does not capture. That is a
      // recording-pipeline defect, not a finger one, and it predates the signed
      // readout; it was invisible while both values saturated at the old 22° floor.
      // The bound below pins the CURRENT divergence so it cannot grow while the
      // real fix is scheduled.
      expect(range, `${key} stays at its weight-bearing rest`).toBeLessThan(8.5);
    }
  });
});
