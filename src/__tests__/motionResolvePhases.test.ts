/**
 * Resolution PHASES (services/motionResolvePhases) — the named steps
 * `resolveComposedMotion` runs a {@link ComposedMotion} through.
 *
 * motionSequence.test.ts covers the resolver's CONTRACT end-to-end; this file
 * covers each pure phase in ISOLATION, which the 580-line monolith could not
 * express: the shape gate, the entry-heading rebase's guard ladder, the
 * loop-wrap floor's cycle-end re-seed, the whole-plan dilation's majority rule
 * and proportion preservation, the pass-through believability clamps, and the
 * authored→resolved boundary remap's exactness at keyframe boundaries.
 *
 * These are STRUCTURAL tests of extracted behaviour — every expectation here
 * describes what the resolver already did, so a drift in a phase is caught at
 * the phase instead of surfacing as a recording/stage divergence downstream.
 */
import { describe, expect, it } from 'vitest';
import {
  applyEntryHeadingRebase,
  applyLoopWrapFloor,
  applyWholePlanRetiming,
  assembleResolvedMotion,
  buildAuthoredToResolvedRemap,
  motionEntryHeadingDeg,
  normalizeYawDeg,
  remapResolvedArtifactTimes,
  validateComposedShape,
  type KeyframeTiming,
} from '../services/motionResolvePhases';
import {
  MAX_KEYFRAMES,
  MAX_KEYFRAME_MS,
  MIN_KEYFRAME_MS,
  type ComposedMotion,
  type ResolvedComposedMotion,
  type ResolvedSequenceKeyframe,
} from '../services/motionSequence';

/** A resolved keyframe carrying the joint targets a floor/dilation reads. */
const rk = (
  durationMs: number,
  targets: { joint: string; motion: string; deg: number }[] = [],
  holdMs = 0,
): ResolvedSequenceKeyframe => ({
  targets: targets.map((t) => ({ joint: t.joint, motion: t.motion, clampedDegrees: t.deg })),
  durationMs,
  holdMs,
  stance: 'floating',
});

const timing = (authoredMs: number, floorMs: number, authoredHoldMs = 0): KeyframeTiming => ({
  authoredMs,
  authoredHoldMs,
  floorMs,
});

// ── PHASE 1 — shape + limits ────────────────────────────────────────────────

describe('validateComposedShape', () => {
  it('accepts a well-shaped plan', () => {
    expect(validateComposedShape({ keyframes: [{ targets: [], durationMs: 500 }] })).toBeNull();
  });

  it('refuses a null/malformed motion and a missing keyframe array', () => {
    expect(validateComposedShape(null as unknown as ComposedMotion)).toBe('invalid-shape');
    expect(validateComposedShape({} as unknown as ComposedMotion)).toBe('invalid-shape');
    expect(validateComposedShape({ keyframes: 'nope' } as unknown as ComposedMotion)).toBe(
      'invalid-shape',
    );
  });

  it('refuses an empty plan', () => {
    expect(validateComposedShape({ keyframes: [] })).toBe('no-keyframes');
  });

  it('refuses past MAX_KEYFRAMES, and accepts exactly at the limit', () => {
    const at = { keyframes: Array.from({ length: MAX_KEYFRAMES }, () => ({ durationMs: 200 })) };
    const over = {
      keyframes: Array.from({ length: MAX_KEYFRAMES + 1 }, () => ({ durationMs: 200 })),
    };
    expect(validateComposedShape(at)).toBeNull();
    expect(validateComposedShape(over)).toBe(`too-many-keyframes (max ${MAX_KEYFRAMES})`);
  });
});

// ── PHASE 4 — persistent heading (SEAM-1) ───────────────────────────────────

describe('normalizeYawDeg', () => {
  it('maps every yaw onto (−180, 180] — the short way around', () => {
    expect(normalizeYawDeg(0)).toBe(0);
    expect(normalizeYawDeg(90)).toBe(90);
    expect(normalizeYawDeg(180)).toBe(180); // the half-open end is INCLUDED
    expect(normalizeYawDeg(181)).toBe(-179); // 1° short way, not 181° long way
    expect(normalizeYawDeg(270)).toBe(-90);
    expect(normalizeYawDeg(360)).toBe(0);
    expect(normalizeYawDeg(540)).toBe(180);
    expect(normalizeYawDeg(-179)).toBe(-179);
    expect(normalizeYawDeg(-181)).toBe(179);
  });
});

describe('motionEntryHeadingDeg', () => {
  it('prefers the constant heading', () => {
    expect(motionEntryHeadingDeg({ keyframes: [], headingDeg: 45 })).toBe(45);
  });

  it("falls back to the heading profile's first point", () => {
    expect(
      motionEntryHeadingDeg({
        keyframes: [],
        headingProfileMs: [
          { tMs: 0, headingDeg: 30 },
          { tMs: 500, headingDeg: 90 },
        ],
      }),
    ).toBe(30);
  });

  it('defaults to 0 (straight ahead), and ignores a non-finite heading', () => {
    expect(motionEntryHeadingDeg({ keyframes: [] })).toBe(0);
    expect(
      motionEntryHeadingDeg({
        keyframes: [],
        headingDeg: Number.NaN,
        headingProfileMs: [{ tMs: 0, headingDeg: 30 }],
      }),
    ).toBe(30);
  });
});

describe('applyEntryHeadingRebase', () => {
  /** A quaternion for a pure yaw about +Y (the root's heading sense). */
  const yawQuat = (deg: number): [number, number, number, number] => {
    const h = (deg * Math.PI) / 360;
    return [0, Math.sin(h), 0, Math.cos(h)];
  };

  const travellingMotion = (): ComposedMotion => ({
    inheritHeading: true,
    footDrivenTravel: true,
    headingDeg: 0,
    keyframes: [{ targets: [], durationMs: 500, root: { translateM: [0, 0, 1] } }],
  });

  it('is identity for an unflagged motion (same object)', () => {
    const m: ComposedMotion = { ...travellingMotion(), inheritHeading: undefined };
    expect(applyEntryHeadingRebase(m, { quat: yawQuat(90) })).toBe(m);
  });

  it("is identity for a 'neutral' start", () => {
    const m: ComposedMotion = { ...travellingMotion(), startFrom: 'neutral' };
    expect(applyEntryHeadingRebase(m, { quat: yawQuat(90) })).toBe(m);
  });

  it('is identity for an un-threaded or malformed root', () => {
    const m = travellingMotion();
    expect(applyEntryHeadingRebase(m, undefined)).toBe(m);
    expect(applyEntryHeadingRebase(m, null)).toBe(m);
    expect(applyEntryHeadingRebase(m, {})).toBe(m);
    // A degenerate quat has no readable heading — rebase by garbage is refused.
    expect(applyEntryHeadingRebase(m, { quat: [0, 0, 0, 0] })).toBe(m);
  });

  it('is identity below the epsilon guard (entering at the authored heading)', () => {
    const m = travellingMotion();
    expect(applyEntryHeadingRebase(m, { quat: yawQuat(0) })).toBe(m);
    // A motion already authored FOR its live entry rebases by ~0 and stays put.
    const authoredForEntry: ComposedMotion = { ...travellingMotion(), headingDeg: 180 };
    expect(applyEntryHeadingRebase(authoredForEntry, { quat: yawQuat(180) })).toBe(
      authoredForEntry,
    );
  });

  it('rotates the whole direction plan by (live yaw − authored entry heading)', () => {
    const out = applyEntryHeadingRebase(travellingMotion(), { quat: yawQuat(90) });
    expect(out).not.toBe(travellingMotion());
    // The travel heading rides the rebase…
    expect(out.headingDeg).toBeCloseTo(90, 6);
    // …and so does the authored translate: +Z 1m becomes +X 1m at a 90° yaw.
    const t = out.keyframes[0]!.root!.translateM!;
    expect(t[0]).toBeCloseTo(1, 6);
    expect(t[1]).toBeCloseTo(0, 6);
    expect(t[2]).toBeCloseTo(0, 6);
  });

  it('takes the SHORT way around a wrap (entry −179 vs authored 180 ⇒ +1°)', () => {
    const m: ComposedMotion = { ...travellingMotion(), headingDeg: 180 };
    const out = applyEntryHeadingRebase(m, { quat: yawQuat(-179) });
    expect(out.headingDeg).toBeCloseTo(181, 4); // 180 + 1, not 180 − 359
  });
});

// ── PHASE 9 — loop-wrap velocity floor (SEAM-7 / DET-RES-01) ────────────────

describe('applyLoopWrapFloor', () => {
  const knee = (deg: number) => [{ joint: 'L_Leg', motion: 'kneeFlexion', deg }];

  it('is a no-op for a non-looping plan', () => {
    const kfs = [rk(300, knee(100)), rk(300, knee(0))];
    const t = [timing(300, 999), timing(300, 999)];
    applyLoopWrapFloor(kfs, t, false);
    expect(kfs[0]!.durationMs).toBe(300);
    expect(t[0]!.floorMs).toBe(999);
  });

  it('is a no-op for a single-keyframe loop (no wrap to read)', () => {
    const kfs = [rk(300, knee(100))];
    const t = [timing(300, 999)];
    applyLoopWrapFloor(kfs, t, true);
    expect(t[0]!.floorMs).toBe(999);
  });

  it("re-seeds kf0's floor from the CYCLE-END pose, not from neutral", () => {
    // kf0 commands 100°; the cycle ends at 0°, so the wrap really asks for 100°
    // (416.7 ms at 240°/s) — and the authored 300 ms is raised to it.
    const kfs = [rk(300, knee(100)), rk(300, knee(0))];
    const t = [timing(300, 12_345), timing(300, 150)];
    applyLoopWrapFloor(kfs, t, true);
    expect(t[0]!.floorMs).toBeCloseTo((100 / 240) * 1000, 6);
    expect(kfs[0]!.durationMs).toBe(Math.ceil((100 / 240) * 1000));
    expect(kfs[0]!.timingAdjusted).toBe(true);
    // Only kf0 moves — kf1 already saw its real predecessor.
    expect(kfs[1]!.durationMs).toBe(300);
    expect(t[1]!.floorMs).toBe(150);
  });

  it('wraps a joint only kf0 touches to its OWN value (zero delta)', () => {
    // Nothing later re-commands the ankle, so the cycle carries 30° round to
    // kf0 unchanged: the wrap delta is 0 and the floor relaxes to the MIN.
    const kfs = [rk(300, [{ joint: 'L_Foot', motion: 'ankleDorsiflexion', deg: 30 }]), rk(300)];
    const t = [timing(300, 12_345), timing(300, 150)];
    applyLoopWrapFloor(kfs, t, true);
    expect(t[0]!.floorMs).toBe(MIN_KEYFRAME_MS);
    expect(kfs[0]!.durationMs).toBe(300); // authored clears the relaxed floor
  });

  it('CLEARS a stale honesty flag when the wrap floor relaxes kf0', () => {
    // The from-neutral floor had bumped kf0; the real wrap asks for far less,
    // so the "I did it, but not that fast" note must not survive.
    const kfs = [rk(300, knee(40)), rk(300, knee(35))];
    kfs[0]!.timingAdjusted = true;
    const t = [timing(300, 12_345), timing(300, 150)];
    applyLoopWrapFloor(kfs, t, true);
    expect(t[0]!.floorMs).toBe(MIN_KEYFRAME_MS); // 5° wrap delta ⇒ MIN floor
    expect(kfs[0]!.durationMs).toBe(300);
    expect('timingAdjusted' in kfs[0]!).toBe(false);
  });

  it('never exceeds the playability cap', () => {
    const kfs = [rk(MAX_KEYFRAME_MS + 5_000, knee(100)), rk(300, knee(0))];
    const t = [timing(MAX_KEYFRAME_MS + 5_000, 150), timing(300, 150)];
    applyLoopWrapFloor(kfs, t, true);
    expect(kfs[0]!.durationMs).toBe(MAX_KEYFRAME_MS);
    expect(kfs[0]!.timingAdjusted).toBe(true);
  });
});

// ── PHASE 10 — whole-plan re-timing (AI-TIME-01) ────────────────────────────

describe('applyWholePlanRetiming', () => {
  it('leaves an ISOLATED violation to the local floor (minority rule)', () => {
    const kfs = [rk(100), rk(400), rk(400), rk(400)];
    const t = [timing(100, 150), timing(400, 150), timing(400, 150), timing(400, 150)];
    expect(applyWholePlanRetiming(kfs, t)).toBe(1);
    expect(kfs.map((k) => k.durationMs)).toEqual([100, 400, 400, 400]);
    expect(kfs.some((k) => k.timingAdjusted)).toBe(false);
  });

  it('never fires on a single keyframe (needs ≥ 2)', () => {
    const kfs = [rk(100)];
    expect(applyWholePlanRetiming(kfs, [timing(100, 150)])).toBe(1);
    expect(kfs[0]!.durationMs).toBe(100);
  });

  it('dilates the WHOLE plan by the worst ratio, preserving phase proportions', () => {
    // 3 of 4 violate (a strict majority); the worst stretch is 1.5×.
    const kfs = [rk(100), rk(100), rk(200), rk(400)];
    const t = [timing(100, 150), timing(100, 150), timing(200, 300), timing(400, 150)];
    expect(applyWholePlanRetiming(kfs, t)).toBeCloseTo(1.5, 9);
    expect(kfs.map((k) => k.durationMs)).toEqual([150, 150, 300, 600]);
    // The authored 1:1:2:4 rhythm survives the dilation exactly.
    expect(kfs.map((k) => k.durationMs / kfs[0]!.durationMs)).toEqual([1, 1, 2, 4]);
    expect(kfs.every((k) => k.timingAdjusted)).toBe(true);
    // Every dilated duration clears its own floor by construction.
    kfs.forEach((k, i) => expect(k.durationMs).toBeGreaterThanOrEqual(t[i]!.floorMs));
  });

  it('dilates holds on the SAME clock as durations', () => {
    const kfs = [rk(100, [], 200), rk(100, [], 0)];
    const t = [timing(100, 150, 200), timing(100, 150, 0)];
    expect(applyWholePlanRetiming(kfs, t)).toBeCloseTo(1.5, 9);
    expect(kfs[0]!.holdMs).toBe(300);
    expect(kfs[1]!.holdMs).toBe(0); // a zero hold never sprouts one
  });

  it('never lets a zero-duration keyframe drive OR receive the dilation', () => {
    // kf0 is a teleport request, not a rhythm: it keeps its local MIN floor.
    const kfs = [rk(0), rk(100), rk(100)];
    const t = [timing(0, 150), timing(100, 150), timing(100, 150)];
    expect(applyWholePlanRetiming(kfs, t)).toBeCloseTo(1.5, 9);
    expect(kfs[0]!.durationMs).toBe(0);
    expect(kfs[0]!.timingAdjusted).toBeUndefined();
    expect(kfs.slice(1).map((k) => k.durationMs)).toEqual([150, 150]);
  });

  it('stands down when ALL violators are degenerate (ratio stays 1)', () => {
    const kfs = [rk(0), rk(0)];
    const t = [timing(0, 150), timing(0, 150)];
    expect(applyWholePlanRetiming(kfs, t)).toBe(1);
    expect(kfs.every((k) => k.timingAdjusted === undefined)).toBe(true);
  });

  it('caps a dilated duration at the playability ceiling', () => {
    const kfs = [rk(MAX_KEYFRAME_MS), rk(MAX_KEYFRAME_MS)];
    const t = [
      timing(MAX_KEYFRAME_MS, MAX_KEYFRAME_MS * 2),
      timing(MAX_KEYFRAME_MS, MAX_KEYFRAME_MS * 2),
    ];
    expect(applyWholePlanRetiming(kfs, t)).toBeCloseTo(2, 9);
    expect(kfs.every((k) => k.durationMs === MAX_KEYFRAME_MS)).toBe(true);
  });
});

// ── PHASE 13 — assemble ─────────────────────────────────────────────────────

describe('assembleResolvedMotion', () => {
  const parts = (over: Partial<Parameters<typeof assembleResolvedMotion>[1]> = {}) => ({
    keyframes: [rk(500)],
    outcomes: [],
    startFrom: 'current' as const,
    derivedSchedule: null,
    gaitNotes: [],
    ...over,
  });

  it('carries the resolved keyframes/outcomes and marks the motion ok', () => {
    const r = assembleResolvedMotion({ name: 'reach', keyframes: [] }, parts());
    expect(r.status).toBe('ok');
    expect(r.name).toBe('reach');
    expect(r.keyframes).toHaveLength(1);
    expect(r.loop).toBe(false);
    expect(r.reps).toBe(1);
    expect(r.startFrom).toBe('current');
  });

  it('clamps reps to a sane finite set (1..50, rounded)', () => {
    const reps = (v: unknown) =>
      assembleResolvedMotion({ keyframes: [], reps: v as number }, parts()).reps;
    expect(reps(undefined)).toBe(1);
    expect(reps(Number.NaN)).toBe(1);
    expect(reps(0)).toBe(1);
    expect(reps(-3)).toBe(1);
    expect(reps(2.6)).toBe(3);
    expect(reps(500)).toBe(50);
  });

  it('clamps the gait vertical to its believability band (1-12 cm)', () => {
    const v = (n?: number) =>
      assembleResolvedMotion({ keyframes: [], verticalCalibrationCm: n }, parts())
        .verticalCalibrationCm;
    expect(v(undefined)).toBeUndefined();
    expect(v(0.2)).toBe(1); // never flattened to a slide
    expect(v(40)).toBe(12); // never ballooned to a hop
    expect(v(5)).toBe(5);
  });

  it('clamps the lateral shuttle to ≤ 6 cm and drops a non-positive one', () => {
    const s = (n?: number) =>
      assembleResolvedMotion({ keyframes: [], lateralShuttleCm: n }, parts()).lateralShuttleCm;
    expect(s(undefined)).toBeUndefined();
    expect(s(0)).toBeUndefined();
    expect(s(-2)).toBeUndefined();
    expect(s(3)).toBe(3);
    expect(s(50)).toBe(6); // never outside its own base of support
  });

  it('omits a zero/non-finite heading (0 IS the default straight-ahead)', () => {
    const h = (n?: number) =>
      assembleResolvedMotion({ keyframes: [], headingDeg: n }, parts()).headingDeg;
    expect(h(0)).toBeUndefined();
    expect(h(Number.NaN)).toBeUndefined();
    expect(h(45)).toBe(45);
  });

  it('drops a malformed heading profile rather than curving along garbage', () => {
    const p = (prof: unknown) =>
      assembleResolvedMotion(
        { keyframes: [], headingProfileMs: prof as { tMs: number; headingDeg: number }[] },
        parts(),
      ).headingProfileMs;
    expect(p(undefined)).toBeUndefined();
    expect(p([{ tMs: 0, headingDeg: 0 }])).toBeUndefined(); // < 2 points is not a curve
    expect(
      p([
        { tMs: 500, headingDeg: 0 },
        { tMs: 100, headingDeg: 90 },
      ]),
    ).toBeUndefined(); // time-disordered
    expect(
      p([
        { tMs: 0, headingDeg: Number.NaN },
        { tMs: 500, headingDeg: 90 },
      ]),
    ).toBeUndefined();
    expect(
      p([
        { tMs: 0, headingDeg: 0 },
        { tMs: 500, headingDeg: 90 },
      ]),
    ).toEqual([
      { tMs: 0, headingDeg: 0 },
      { tMs: 500, headingDeg: 90 },
    ]);
  });

  it('filters malformed contacts and stance windows', () => {
    const r = assembleResolvedMotion(
      {
        keyframes: [],
        contacts: [{ foot: 'L_Foot' }, { foot: 42 } as unknown as { foot: string }, null!],
        gaitStanceWindowsMs: [
          { foot: 'L_Foot', fromMs: 0, toMs: 400 },
          { foot: 'R_Foot', fromMs: 400, toMs: 400 }, // zero-length
          { foot: 'R_Foot', fromMs: 400, toMs: Number.NaN },
        ],
      },
      parts(),
    );
    expect(r.contacts).toEqual([{ foot: 'L_Foot' }]);
    expect(r.gaitStanceWindowsMs).toEqual([{ foot: 'L_Foot', fromMs: 0, toMs: 400 }]);
  });

  it('keeps only the explicit heel-strike opt-OUT (default-on = absent)', () => {
    expect(
      assembleResolvedMotion({ keyframes: [], heelStrikeAccent: false }, parts()).heelStrikeAccent,
    ).toBe(false);
    expect(
      assembleResolvedMotion({ keyframes: [], heelStrikeAccent: true }, parts()).heelStrikeAccent,
    ).toBeUndefined();
  });

  it('lets a DERIVED gait schedule win, and narrates via notes', () => {
    const r = assembleResolvedMotion(
      { keyframes: [], contacts: [{ foot: 'L_Foot' }] },
      parts({
        derivedSchedule: {
          gaitStanceWindowsMs: [{ foot: 'R_Foot', fromMs: 0, toMs: 400 }],
          contacts: [{ foot: 'R_Foot', fromMs: 0, toMs: 400 }],
        },
        gaitNotes: ['gait plumbing attached'],
      }),
    );
    expect(r.contacts).toEqual([{ foot: 'R_Foot', fromMs: 0, toMs: 400 }]);
    expect(r.gaitStanceWindowsMs).toEqual([{ foot: 'R_Foot', fromMs: 0, toMs: 400 }]);
    expect(r.notes).toEqual(['gait plumbing attached']);
  });

  it('omits notes entirely when resolution attached nothing', () => {
    expect(assembleResolvedMotion({ keyframes: [] }, parts()).notes).toBeUndefined();
  });

  it('does not mutate the input motion', () => {
    const motion: ComposedMotion = { keyframes: [], reps: 500, verticalCalibrationCm: 40 };
    assembleResolvedMotion(motion, parts());
    expect(motion.reps).toBe(500);
    expect(motion.verticalCalibrationCm).toBe(40);
  });
});

// ── PHASE 14 — authored → resolved boundary remap (SEAM-7, part 2) ──────────

describe('buildAuthoredToResolvedRemap', () => {
  it('returns null when NO keyframe boundary moved (byte-identical skip)', () => {
    const kfs = [rk(100, [], 50), rk(200)];
    const t = [timing(100, 0, 50), timing(200, 0)];
    expect(buildAuthoredToResolvedRemap(t, kfs)).toBeNull();
  });

  it('returns null when a hold absorbs exactly what a duration lost', () => {
    // The BOUNDARIES are what matter, not the duration/hold split.
    const kfs = [rk(150, [], 0)];
    const t = [timing(100, 0, 50)];
    expect(buildAuthoredToResolvedRemap(t, kfs)).toBeNull();
  });

  describe('with kf0 stretched 100→200 and kf1 held at 100', () => {
    // authored boundaries [100, 200]; resolved boundaries [200, 300].
    const remap = () =>
      buildAuthoredToResolvedRemap(
        [timing(100, 0), timing(100, 0)],
        [rk(200), rk(100)],
      )!;

    it('is built (the plan reflowed)', () => {
      expect(remap()).not.toBeNull();
    });

    it('maps keyframe BOUNDARIES exactly — a window ends where it ended', () => {
      expect(remap()(100)).toBeCloseTo(200, 9);
      expect(remap()(200)).toBeCloseTo(300, 9);
    });

    it('maps interior times piecewise-linearly within their own keyframe', () => {
      expect(remap()(50)).toBeCloseTo(100, 9); // half of kf0
      expect(remap()(150)).toBeCloseTo(250, 9); // half of kf1
    });

    it('passes the start, negatives and non-finite pins straight through', () => {
      expect(remap()(0)).toBe(0);
      expect(remap()(-25)).toBe(-25);
      expect(remap()(undefined)).toBeUndefined();
      expect(Number.isNaN(remap()(Number.NaN) as number)).toBe(true);
      expect(remap()(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    });

    it("keeps a past-the-end tail's distance from the cycle end", () => {
      expect(remap()(250)).toBeCloseTo(350, 9); // 50 past the end, still 50 past
    });

    it('is monotonic across the whole authored span', () => {
      const f = remap();
      let prev = -Infinity;
      for (let t = 0; t <= 200; t += 10) {
        const v = f(t) as number;
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    });
  });
});

describe('remapResolvedArtifactTimes', () => {
  it('remaps contacts, stance windows and the heading profile onto one clock', () => {
    const resolved: ResolvedComposedMotion = {
      status: 'ok',
      keyframes: [],
      outcomes: [],
      loop: true,
      reps: 1,
      startFrom: 'current',
      contacts: [{ foot: 'L_Foot', fromMs: 0, toMs: 100 }],
      gaitStanceWindowsMs: [{ foot: 'L_Foot', fromMs: 100, toMs: 200 }],
      headingProfileMs: [
        { tMs: 0, headingDeg: 0 },
        { tMs: 200, headingDeg: 90 },
      ],
    };
    const remap = buildAuthoredToResolvedRemap(
      [timing(100, 0), timing(100, 0)],
      [rk(200), rk(100)],
    )!;
    remapResolvedArtifactTimes(resolved, remap);
    expect(resolved.contacts).toEqual([{ foot: 'L_Foot', fromMs: 0, toMs: 200 }]);
    expect(resolved.gaitStanceWindowsMs).toEqual([{ foot: 'L_Foot', fromMs: 200, toMs: 300 }]);
    expect(resolved.headingProfileMs).toEqual([
      { tMs: 0, headingDeg: 0 },
      { tMs: 300, headingDeg: 90 },
    ]);
  });

  it('leaves a whole-motion contact pin (no fromMs/toMs) untouched', () => {
    const resolved: ResolvedComposedMotion = {
      status: 'ok',
      keyframes: [],
      outcomes: [],
      loop: false,
      reps: 1,
      startFrom: 'current',
      contacts: [{ foot: 'L_Foot' }],
    };
    const remap = buildAuthoredToResolvedRemap([timing(100, 0)], [rk(200)])!;
    remapResolvedArtifactTimes(resolved, remap);
    expect(resolved.contacts).toEqual([{ foot: 'L_Foot' }]);
  });

  it('is a no-op for a motion carrying no ms-authored artifacts', () => {
    const resolved: ResolvedComposedMotion = {
      status: 'ok',
      keyframes: [],
      outcomes: [],
      loop: false,
      reps: 1,
      startFrom: 'current',
    };
    const remap = buildAuthoredToResolvedRemap([timing(100, 0)], [rk(200)])!;
    expect(() => remapResolvedArtifactTimes(resolved, remap)).not.toThrow();
    expect(resolved.contacts).toBeUndefined();
  });
});
