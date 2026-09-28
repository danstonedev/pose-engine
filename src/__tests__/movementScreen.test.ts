// THE MOVEMENT SCREEN — the FMS and SFMA library simMOVE's Screen and simLAB
// both play.
//
// Moved from simMOVE with the library: its screenBalance tests and the parts of
// its screenPositions tests that exercise the library rather than simMOVE's own
// data and cases (those stay in simMOVE). Then the registry's contract: every
// pattern named, resolvable on both sides, posed where it says, and given the
// screening kit the protocol uses.

import { describe, it, expect } from 'vitest';
import { MOVEMENT_TEMPLATES, buildSquat } from '../services/movementTemplates';
import { resolveComposedMotion } from '../services/motionSequence';
import type { RomScenarioConstraints } from '../services/romConstraints';
import {
  FMS_POSITIONS,
  TOP_TIER_POSITIONS,
  MOVEMENT_SCREEN,
  OVERHEAD_ARM_TESTS,
  SCREEN_KIT,
  SQUAT_CLEAN_DF_DEG,
  assessmentSourceNotes,
  composeScreenMotion,
  movementScreenMotion,
  movementScreenPattern,
  positionFor,
  resolvePosition,
  screenSourceAvailable,
  squatDorsiflexionCap,
  type PositionSource,
} from '../services/movementScreen';

const ankleCap = (max: number): RomScenarioConstraints => ({
  R_Foot: { ankleFlexion: { availableRange: { max } } },
  L_Foot: { ankleFlexion: { availableRange: { max } } },
});

// ─── The overhead press and the squat's compensation (simMOVE screenBalance) ──
//
// `squatCompensation`'s constants were fitted on the base-of-support harness
// WITH buildSquat's authored 60-degree arm-forward counterweight. The FMS squat
// overrides the arms overhead, and nothing re-solves the weight shift — so in
// principle the override could walk the mannequin's centre of mass off its base
// and nobody would see it, because no gate compares the two. Measured, authoring
// the press as ABDUCTION costs almost nothing; authoring it as FLEXION cost about
// 2.3 cm and moved the compensate-else-fall crossover from df~15.6 to ~18.3.

/** Total authored trunk excursion — the proxy for how hard the compensation is
 *  working. It is what visibly differs between a clean and an impaired squat,
 *  and it is what an arm re-authoring would perturb. */
function trunkLoad(m: ReturnType<typeof resolvePosition>): number {
  let sum = 0;
  for (const kf of m!.keyframes) {
    for (const t of kf.targets) {
      if (t.joint === 'Spine_Lower' || t.joint === 'Spine_Upper') {
        sum = Math.max(sum, Math.abs(t.clampedDegrees));
      }
    }
  }
  return sum;
}

const shipped = (df: number) =>
  resolvePosition(positionFor('deep-squat'), 'R', ankleCap(df), 'deep-squat', 'hold');

const plain = (df: number) =>
  resolveComposedMotion(buildSquat({ dorsiflexionCapDeg: df }), undefined, {
    constraints: ankleCap(df),
  });

describe('the FMS overhead override does not disturb its compensation solver', () => {
  const SWEEP = [32, 26, 20, 18, 16, 14, 8];

  it('leaves the trunk compensation identical to the plain squat at every cap', () => {
    // The arms are downstream of the solver: it keys off the dorsiflexion cap,
    // not off what the arms are doing. If an arm authoring ever started feeding
    // back into the trunk, this is where it would show.
    for (const df of SWEEP) {
      expect(trunkLoad(shipped(df)), `df=${df}`).toBeCloseTo(trunkLoad(plain(df) as never), 5);
    }
  });

  it('still reaches the engine-asserted balanced case at df 18', () => {
    // df=18 is inside the band buildSquat's own calibration sweep records as
    // balanced (margin +1.9 cm). The flexion-based override drove it negative.
    const m = shipped(18);
    expect(m).not.toBeNull();
    expect(m!.status).toBe('ok');
  });

  it('drives the trunk harder as the ankle is blocked, monotonically', () => {
    const loads = SWEEP.map((df) => trunkLoad(shipped(df)));
    for (let i = 1; i < loads.length; i++) {
      expect(loads[i], `df ${SWEEP[i]} vs ${SWEEP[i - 1]}`).toBeGreaterThanOrEqual(loads[i - 1]);
    }
  });

  it('holds the clean squat at the builder weight-bearing default', () => {
    // 32, not 20. The 20-degree figure is ankle DF's SEATED OPEN-CHAIN norm and
    // is the wrong domain for a squat; authored there, the solver has already
    // spent its whole hip budget before any impairment applies.
    expect(SQUAT_CLEAN_DF_DEG).toBe(32);
  });
});

describe('assessment shoulders preserve calibrated overhead targets and girdle ownership', () => {
  const ALL = MOVEMENT_SCREEN.map((pattern) => pattern.testId);

  it('keeps each calibrated squat overhead arm on one humeral channel', () => {
    // The two squat overrides were measured with a single abduction command;
    // adding a flexion channel changes that calibrated pose and balance basis.
    for (const id of ['deep-squat', 'overhead-deep-squat']) for (const side of ['R', 'L'] as const) for (const mode of ['hold', 'movement'] as const) {
      const m = resolvePosition(positionFor(id), side, null, id, mode);
      expect(m?.status, `${id} ${side} ${mode}`).toBe('ok');
      for (const kf of m!.keyframes) {
        const perJoint = new Map<string, string[]>();
        for (const t of kf.targets) {
          if (!t.joint.endsWith('_UpperArm')) continue;
          perJoint.set(t.joint, [...(perJoint.get(t.joint) ?? []), t.motion]);
        }
        for (const [joint, motions] of perJoint) {
          expect(motions.length, `${id}: ${joint} carries ${motions.join('+')}`).toBe(1);
        }
        for (const t of kf.targets.filter(t => t.joint.endsWith('_UpperArm') && t.clampedDegrees > 0)) {
          expect(t.motion, `${id}: ${t.joint} overhead channel`).toBe('shoulderAbduction');
        }
      }
    }
  });

  it('never repeats the same joint-motion command within an assessment keyframe', () => {
    for (const id of ALL) for (const side of ['R', 'L'] as const) {
      const m = resolvePosition(positionFor(id), side, null, id, 'movement');
      expect(m?.status, `${id} ${side}`).toBe('ok');
      for (const kf of m!.keyframes) {
        const keys = kf.targets.map(target => `${target.joint}/${target.motion}`);
        expect(new Set(keys).size, `${id} ${side}: duplicate joint-motion command`).toBe(keys.length);
      }
    }
  });

  it('never authors a scapula on a limb whose humerus it also commands', () => {
    // writeGirdle owns the clavicle. An authored X_Shoulder alongside an
    // X_UpperArm target clobbers: arm-last drops the scapula silently,
    // scapula-last wrings the humerus by up to -142.9 degrees of phantom axial
    // rotation. Neither is reported — everything says 'complied'.
    for (const id of ALL) for (const selectedSide of ['R', 'L'] as const) {
      const m = resolvePosition(positionFor(id), selectedSide, null, id, 'movement');
      expect(m?.status, `${id} ${selectedSide}`).toBe('ok');
      for (const kf of m!.keyframes) {
        const arms = new Set(
          kf.targets.filter((t) => t.joint.endsWith('_UpperArm')).map((t) => t.joint[0]),
        );
        const scapulae = new Set(
          kf.targets.filter((t) => t.joint.endsWith('_Shoulder')).map((t) => t.joint[0]),
        );
        for (const side of scapulae) {
          expect(arms.has(side), `${id}: ${side}_Shoulder authored beside ${side}_UpperArm`).toBe(false);
        }
      }
    }
  });
});

// ─── The position registry's contract with the engine (simMOVE screenPositions)

const ALL_SOURCES: [string, PositionSource][] = [
  ...Object.entries(FMS_POSITIONS),
  ...Object.entries(TOP_TIER_POSITIONS),
];

describe('position registry ↔ engine', () => {
  it('names only templates that exist in the engine', () => {
    const ids = new Set(MOVEMENT_TEMPLATES.map((t) => t.id));
    const named = ALL_SOURCES.filter(([, s]) => s.kind === 'template') as [
      string,
      { kind: 'template'; templateId: string },
    ][];
    for (const [testId, src] of named) {
      expect(ids.has(src.templateId), `${testId} → template '${src.templateId}'`).toBe(true);
    }
  });

  it('resolves every available position into a playable motion', () => {
    for (const [testId, src] of ALL_SOURCES) {
      expect(screenSourceAvailable(src), testId).toBe(true);
      const resolved = resolvePosition(src, 'R', null);
      expect(resolved, `${testId} resolved`).not.toBeNull();
      expect(resolved!.keyframes.length, `${testId} has keyframes`).toBeGreaterThan(0);
    }
  });

  it('an unposed position resolves to null rather than an empty motion', () => {
    const src = positionFor('not-authored');
    expect(src.kind).toBe('unposed');
    expect(screenSourceAvailable(src)).toBe(false);
    expect(resolvePosition(src, 'R', null)).toBeNull();
  });

  it('leaves an app-held pose to the app that holds it', () => {
    const src: PositionSource = { kind: 'pose', poseId: 'captured' };
    expect(screenSourceAvailable(src)).toBe(false);
    expect(composeScreenMotion(src, 'R', null)).toBeNull();
  });

  it('gives every authored source its notes, and a builder none', () => {
    for (const [testId, src] of ALL_SOURCES) {
      if (src.kind === 'authored') expect(assessmentSourceNotes(src).length, testId).toBeGreaterThan(0);
      else expect(assessmentSourceNotes(src), testId).toEqual([]);
    }
  });
});

describe('an authored impairment produces a visible compensation', () => {
  // A case authors one number — the ankle's available range — and both the
  // movement the student watches and the answer key follow from it. The failure
  // mode is silent and total: hardcode the cap instead of passing the case's,
  // and the clean squat and a badly restricted one resolve byte-identically.
  const peak = (m: ReturnType<typeof resolvePosition>, joint: string, motion: string) => {
    let p = -Infinity;
    for (const kf of m!.keyframes) {
      for (const t of kf.targets) {
        if (t.joint === joint && t.motion === motion) p = Math.max(p, t.clampedDegrees);
      }
    }
    return p === -Infinity ? null : p;
  };

  const squatOf = (testId: string) => (c: RomScenarioConstraints | null) =>
    resolvePosition(positionFor(testId), 'R', c, testId);
  const squat = squatOf('deep-squat');

  it('reads the case\'s available range as the builder\'s dorsiflexion cap', () => {
    expect(squatDorsiflexionCap(null)).toBe(SQUAT_CLEAN_DF_DEG);
    expect(squatDorsiflexionCap(ankleCap(8))).toBe(8);
    // The tighter ankle wins: a squat is bilateral and the worse side forces it.
    expect(
      squatDorsiflexionCap({
        R_Foot: { ankleFlexion: { availableRange: { max: 8 } } },
        L_Foot: { ankleFlexion: { availableRange: { max: 20 } } },
      }),
    ).toBe(8);
    // A case can only restrict, never author a deeper-than-clean "normal".
    expect(squatDorsiflexionCap(ankleCap(90))).toBe(SQUAT_CLEAN_DF_DEG);
  });

  it('folds the torso forward as the ankle is blocked', () => {
    const clean = squat(null);
    const blocked = squat(ankleCap(8));
    expect(peak(clean, 'R_Foot', 'ankleFlexion')).toBe(SQUAT_CLEAN_DF_DEG);
    expect(peak(blocked, 'R_Foot', 'ankleFlexion')).toBe(8);
    for (const [joint, motion] of [
      ['R_UpLeg', 'hipFlexion'],
      ['Spine_Lower', 'flexion'],
      ['Spine_Upper', 'flexion'],
    ] as const) {
      const c = peak(clean, joint, motion)!;
      const b = peak(blocked, joint, motion)!;
      expect(b, `${joint}.${motion} ${c} -> ${b}`).toBeGreaterThan(c);
    }
  });

  it('compensates progressively, not as an on/off switch', () => {
    const lumbar = [32, 20, 8].map((df) => peak(squat(ankleCap(df)), 'Spine_Lower', 'flexion')!);
    expect(lumbar[0]).toBeLessThan(lumbar[1]);
    expect(lumbar[1]).toBeLessThan(lumbar[2]);
  });

  it('holds every compensated joint inside its normative ROM', () => {
    const blocked = squat(ankleCap(0));
    expect(peak(blocked, 'R_UpLeg', 'hipFlexion')!).toBeLessThanOrEqual(120);
    expect(peak(blocked, 'Spine_Lower', 'flexion')!).toBeLessThanOrEqual(60);
    expect(peak(blocked, 'Spine_Upper', 'flexion')!).toBeLessThanOrEqual(40);
  });

  it('a constraint on an UNRELATED joint leaves the squat alone', () => {
    const clean = squat(null);
    const elsewhere = squat({ R_Shoulder: { shoulderFlexion: { availableRange: { max: 30 } } } });
    expect(peak(elsewhere, 'R_UpLeg', 'hipFlexion')).toBe(peak(clean, 'R_UpLeg', 'hipFlexion'));
  });

  // The SFMA overhead squat is its own authored feet-together source. When it
  // stopped using the builder it silently lost the compensation above while every
  // FMS-squat test stayed green, so the same contract is pinned on it directly.
  describe('on the authored SFMA overhead squat', () => {
    const sfmaSquat = squatOf('overhead-deep-squat');
    const hold = (m: ReturnType<typeof resolvePosition>) => m!.keyframes.find((kf) => kf.holdMs)!;
    const at = (kf: ReturnType<typeof hold>, joint: string, motion: string) =>
      kf.targets.find((t) => t.joint === joint && t.motion === motion)!.clampedDegrees;

    it('folds the torso forward as the ankle is blocked', () => {
      const clean = sfmaSquat(null);
      const blocked = sfmaSquat(ankleCap(8));
      expect(peak(blocked, 'R_Foot', 'ankleFlexion')).toBe(8);
      expect(peak(clean, 'R_Foot', 'ankleFlexion')!).toBeGreaterThan(8);
      for (const [joint, motion] of [
        ['R_UpLeg', 'hipFlexion'],
        ['Spine_Lower', 'flexion'],
        ['Spine_Upper', 'flexion'],
      ] as const) {
        const c = peak(clean, joint, motion)!;
        const b = peak(blocked, joint, motion)!;
        expect(b, `${joint}.${motion} ${c} -> ${b}`).toBeGreaterThan(c);
      }
    });

    it('compensates progressively and inside normative ROM', () => {
      const lumbar = [32, 20, 8].map((df) => peak(sfmaSquat(ankleCap(df)), 'Spine_Lower', 'flexion')!);
      expect(lumbar[0]).toBeLessThan(lumbar[1]);
      expect(lumbar[1]).toBeLessThan(lumbar[2]);
      const blocked = sfmaSquat(ankleCap(0));
      expect(peak(blocked, 'R_UpLeg', 'hipFlexion')!).toBeLessThanOrEqual(120);
      expect(peak(blocked, 'Spine_Lower', 'flexion')!).toBeLessThanOrEqual(60);
      expect(peak(blocked, 'Spine_Upper', 'flexion')!).toBeLessThanOrEqual(40);
    });

    it('keeps the setup and return clean, and the clean squat unchanged', () => {
      const clean = sfmaSquat(null)!, blocked = sfmaSquat(ankleCap(8))!;
      for (const index of [0, blocked.keyframes.length - 1]) {
        expect(at(blocked.keyframes[index], 'Spine_Lower', 'flexion')).toBe(at(clean.keyframes[index], 'Spine_Lower', 'flexion'));
        expect(at(blocked.keyframes[index], 'R_UpLeg', 'hipFlexion')).toBe(at(clean.keyframes[index], 'R_UpLeg', 'hipFlexion'));
      }
      expect(sfmaSquat(ankleCap(90))).toEqual(clean);
      expect(at(hold(clean), 'Spine_Lower', 'flexion')).toBe(0);
    });
  });
});

describe('the overhead tests actually press overhead', () => {
  // The arms are authored as ABDUCTION (flexion keeps the rest splay: a wide V,
  // hands 0.716 m apart), with NO scapular target (writeGirdle owns it), and the
  // flexion target is REPLACED, not supplemented.
  const targetsOf = (testId: string) => {
    const m = resolvePosition(positionFor(testId), 'R', null, testId)!;
    return m.keyframes.flatMap((kf) => kf.targets);
  };
  const peak = (testId: string, joint: string, motion: string) => {
    let p = -Infinity;
    for (const t of targetsOf(testId)) {
      if (t.joint === joint && t.motion === motion) p = Math.max(p, t.clampedDegrees);
    }
    return p === -Infinity ? null : p;
  };

  it('elevates through ABDUCTION, which reaches vertical', () => {
    for (const id of ['deep-squat', 'overhead-deep-squat']) {
      expect(OVERHEAD_ARM_TESTS.has(id)).toBe(true);
      expect(peak(id, 'R_UpperArm', 'shoulderAbduction'), id).toBe(160);
      expect(peak(id, 'L_UpperArm', 'shoulderAbduction'), id).toBe(160);
    }
  });

  it('REPLACES the flexion target rather than adding a second field', () => {
    for (const id of ['deep-squat', 'overhead-deep-squat']) {
      for (const kf of resolvePosition(positionFor(id), 'R', null, id)!.keyframes) {
        const perArm = new Map<string, Set<string>>();
        for (const t of kf.targets) {
          if (!t.joint.endsWith('_UpperArm')) continue;
          (perArm.get(t.joint) ?? perArm.set(t.joint, new Set()).get(t.joint)!).add(t.motion);
        }
        for (const [joint, motions] of perArm) {
          expect(motions.size, `${id} ${joint} fields ${[...motions]}`).toBe(1);
        }
      }
    }
  });

  it('authors NO scapular target, because doing so clobbers the humerus', () => {
    for (const id of ['deep-squat', 'overhead-deep-squat']) {
      const scap = targetsOf(id).filter((t) => t.joint.endsWith('_Shoulder'));
      expect(scap, `${id} must let writeGirdle own the scapula`).toHaveLength(0);
    }
  });

  it('stays below the readout wrap at 164 degrees', () => {
    for (const id of ['deep-squat', 'overhead-deep-squat']) {
      expect(peak(id, 'R_UpperArm', 'shoulderAbduction')!, id).toBeLessThan(164);
    }
  });

  it('retains the FMS builder press and return', () => {
    const m = resolvePosition(positionFor('deep-squat'), 'R', null, 'deep-squat')!;
    const last = m.keyframes[m.keyframes.length - 1].targets.find(
      (t) => t.joint === 'R_UpperArm',
    );
    expect(last?.clampedDegrees).toBe(0);
  });

  it('leaves a NON-overhead resolve with its authored counterweight arms', () => {
    const m = resolvePosition(positionFor('deep-squat'), 'R', null)!;
    const flex = m.keyframes
      .flatMap((k) => k.targets)
      .filter((t) => t.motion === 'shoulderFlexion')
      .map((t) => t.clampedDegrees);
    expect(Math.max(...flex)).toBe(60);
    expect(m.keyframes.flatMap((k) => k.targets).some((t) => t.motion === 'shoulderAbduction')).toBe(false);
  });
});

describe('authored positions reach the range their criterion names', () => {
  const peakNeck = (testId: string) => {
    const m = resolvePosition(positionFor(testId), 'R', null, testId)!;
    let lo = Infinity;
    let hi = -Infinity;
    for (const kf of m.keyframes) {
      for (const t of kf.targets) {
        if (t.joint === 'Neck' && t.motion === 'flexion') {
          lo = Math.min(lo, t.clampedDegrees);
          hi = Math.max(hi, t.clampedDegrees);
        }
      }
    }
    return { lo, hi };
  };

  it('takes the chin toward the chest in cervical flexion', () => {
    expect(peakNeck('cervical-flexion').hi).toBe(50);
  });

  it('takes the head back in cervical extension, the other sign', () => {
    expect(peakNeck('cervical-extension').lo).toBe(-60);
  });

  it('pins the trunk neutral, so a trunk substitution reads as a fault', () => {
    const m = resolvePosition(positionFor('cervical-flexion'), 'R', null, 'cervical-flexion')!;
    for (const kf of m.keyframes) {
      for (const t of kf.targets) {
        if (t.joint === 'Spine_Lower' || t.joint === 'Spine_Upper') {
          expect(t.clampedDegrees).toBe(0);
        }
      }
    }
  });
});

// ─── The registry ────────────────────────────────────────────────────────────

describe('the movement screen registry', () => {
  const byTest = (testId: string) => MOVEMENT_SCREEN.find((pattern) => pattern.testId === testId)!;

  it('names the seven FMS tests, the three clearing tests and the ten SFMA top-tier patterns once each', () => {
    const count = (system: string, kind: string) => MOVEMENT_SCREEN.filter((p) => p.system === system && p.kind === kind).length;
    expect([count('fms', 'test'), count('fms', 'clearing'), count('sfma', 'top-tier')]).toEqual([7, 3, 10]);
    expect(new Set(MOVEMENT_SCREEN.map((p) => p.id)).size).toBe(20);
    expect(new Set(MOVEMENT_SCREEN.map((p) => p.testId))).toEqual(new Set([...Object.keys(FMS_POSITIONS), ...Object.keys(TOP_TIER_POSITIONS)]));
  });

  it('keys each pattern by the movement id simMOVE and the Exam audit already use', () => {
    // These ids name simMOVE's movement files and sign-offs and simLAB's audit
    // rows (and so the notes reviewers have left on them): they must not drift.
    expect(byTest('deep-squat').id).toBe('fms-repo-legacy-v1/deep-squat/deep-squat');
    expect(byTest('shoulder-clearing').id).toBe('fms-repo-legacy-v1/shoulder-mobility/shoulder-clearing');
    expect(byTest('extension-clearing').id).toBe('fms-repo-legacy-v1/trunk-stability-push-up/extension-clearing');
    expect(byTest('flexion-clearing').id).toBe('fms-repo-legacy-v1/rotary-stability/flexion-clearing');
    expect(byTest('single-leg-stance').id).toBe('sfma-repo-legacy-v1/single-leg-stance/top-tier');
    for (const p of MOVEMENT_SCREEN) {
      expect(p.id, p.testId).toMatch(p.system === 'fms' ? /^fms-repo-legacy-v1\/[a-z-]+\/[a-z-]+$/ : /^sfma-repo-legacy-v1\/[a-z-]+\/top-tier$/);
      expect(movementScreenPattern(p.id)).toBe(p);
    }
    expect(movementScreenPattern('sfma-repo-legacy-v1/single-leg-stance/eyes-closed')).toBeUndefined();
  });

  it('plays every pattern on both sides, as the whole movement and held', () => {
    for (const p of MOVEMENT_SCREEN) for (const side of ['L', 'R'] as const) for (const mode of ['movement', 'hold'] as const) {
      const motion = movementScreenMotion(p, side, mode);
      expect(motion, `${p.testId} ${side} ${mode}`).not.toBeNull();
      expect(motion).toEqual(composeScreenMotion(positionFor(p.testId), side, null, p.testId, mode));
      expect(resolveComposedMotion(motion!).status, `${p.testId} ${side} ${mode}`).toBe('ok');
    }
  });

  it('says what the side names exactly when the two sides differ', () => {
    for (const p of MOVEMENT_SCREEN) {
      const differ = JSON.stringify(movementScreenMotion(p, 'L')) !== JSON.stringify(movementScreenMotion(p, 'R'));
      expect(p.side !== null, `${p.testId}: side ${p.side}`).toBe(differ);
    }
  });

  it('starts each pattern in the posture it names', () => {
    for (const p of MOVEMENT_SCREEN) {
      expect(movementScreenMotion(p, 'R')!.startPosture ?? 'standing', p.testId).toBe(p.posture);
    }
    expect(MOVEMENT_SCREEN.filter((p) => p.posture !== 'standing').map((p) => p.testId).sort()).toEqual(
      ['aslr', 'extension-clearing', 'flexion-clearing', 'rotary-stability', 'trunk-stability-push-up'],
    );
  });

  it('gives each FMS test the kit the protocol uses, and nothing else any', () => {
    const kit = Object.fromEntries(MOVEMENT_SCREEN.filter((p) => p.equipment.length).map((p) => [p.testId, p.equipment]));
    expect(kit).toEqual({
      'deep-squat': [{ kind: 'dowel', hold: 'overhead' }],
      'hurdle-step': [{ kind: 'hurdle' }, { kind: 'dowel', hold: 'across-shoulders' }],
      'in-line-lunge': [{ kind: 'board', placement: 'under-feet' }, { kind: 'dowel', hold: 'along-spine' }],
      aslr: [{ kind: 'board', placement: 'under-knees' }, { kind: 'dowel', hold: 'upright-by-thigh' }],
      'rotary-stability': [{ kind: 'board', placement: 'between-hands-and-knees' }],
    });
    // The SFMA's legacy overhead squat raises the arms without a dowel.
    expect(byTest('overhead-deep-squat').equipment).toEqual([]);
    for (const part of Object.values(SCREEN_KIT)) for (const size of Object.values(part)) expect(size).toBeGreaterThan(0);
  });
});
