/**
 * Scenario ROM constraints — per-patient overrides of the normative registry.
 *
 * The ROM registry (`romRegistry.ts`) carries the AAOS/Norkin & White normative
 * ranges every host shares. A clinical scenario, though, presents a *patient*:
 * an elbow that only flexes to 95° because of effusion, a painful arc of
 * shoulder abduction, an empty end-feel. This module holds that per-scenario
 * layer: hosts set constraints when a case loads, the ROM clamp
 * (`poseRomClamp.ts`) enforces the *effective* range (normative ∩ constraint),
 * and readout UIs can render available-vs-normal range and painful arcs.
 *
 * Constraints are passed EXPLICITLY (PR 2): `resolveComposedMotion` takes them in
 * `ResolveComposedOptions.constraints`, the ROM clamp takes them as an argument,
 * and readouts pass them in. There is no module-global "active scenario" store —
 * hidden global state broke reliable preflight, multiple stages, and concurrent
 * evaluation (a background preflight resolve could clobber the live scenario). A
 * caller with no per-patient overrides passes `null` (normative ROM applies).
 */
import {
  getRomFieldDefinition,
  type RomFieldDefinition,
  type RomRangeDeg,
} from './romRegistry';

/** Classic clinical end-feel vocabulary, plus free text via `note`. */
export type RomEndFeel =
  | 'soft'
  | 'firm'
  | 'hard'
  | 'boggy'
  | 'empty'
  | 'spasm'
  | 'capsular'
  | 'springy-block';

/** A scenario's constraint on ONE ROM field (e.g. `R_Forearm.elbowFlexion`). */
export interface RomFieldConstraint {
  /**
   * The patient's available range for this field, deg, in the registry's
   * clinical convention. Omit a bound to inherit the normative bound; either
   * bound is clamped into the normative range (a scenario can only restrict,
   * never extend, what the rig allows).
   */
  availableRange?: Partial<RomRangeDeg>;
  /**
   * A painful arc within the available range (deg). Reported to the UI
   * (`isInRomPainfulArc`) so movement through it can be visualized/voiced —
   * it does NOT stop motion; only `availableRange` clamps.
   */
  painfulArc?: RomRangeDeg;
  /** End-feel at the available-range limit, for exam feedback. */
  endFeel?: RomEndFeel;
  /** Author note (e.g. "guarding beyond 90°, morning stiffness"). */
  note?: string;
}

/** fieldKey → constraint, e.g. `{ elbowFlexion: {...} }`. */
export type RomJointConstraints = Record<string, RomFieldConstraint>;

/** canonicalKey → joint constraints, e.g. `{ R_Forearm: {...} }`. */
export type RomScenarioConstraints = Record<string, RomJointConstraints>;

/** Normalize a constraints object: an empty set is the same as none. */
export function normalizeRomConstraints(
  constraints: RomScenarioConstraints | null | undefined,
): RomScenarioConstraints | null {
  return constraints && Object.keys(constraints).length > 0 ? constraints : null;
}

/** The constraint for one joint field in the GIVEN scenario set, or undefined
 *  when unconstrained. Constraints are passed explicitly (no module-global). */
export function getRomFieldConstraint(
  constraints: RomScenarioConstraints | null | undefined,
  canonicalKey: string | null | undefined,
  fieldKey: string | null | undefined,
): RomFieldConstraint | undefined {
  if (!constraints || !canonicalKey || !fieldKey) return undefined;
  return constraints[canonicalKey]?.[fieldKey];
}

/**
 * Intersect a constraint's available range with the normative range. Bounds
 * the scenario forgot (or authored outside the normative window) fall back to
 * the normative bound, and a degenerate authoring error (min > max) collapses
 * to the min so the clamp stays stable rather than oscillating.
 */
export function resolveAvailableRange(
  normative: RomRangeDeg,
  constraint: RomFieldConstraint | undefined,
): RomRangeDeg {
  const avail = constraint?.availableRange;
  if (!avail) return normative;
  const min = clampFinite(avail.min, normative.min, normative);
  const max = clampFinite(avail.max, normative.max, normative);
  return max >= min ? { min, max } : { min, max: min };
}

function clampFinite(value: number | undefined, fallback: number, bounds: RomRangeDeg): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(bounds.min, Math.min(bounds.max, value));
}

/**
 * The range the clamp should enforce for a joint field RIGHT NOW: the
 * registry's normative range intersected with any active scenario constraint.
 * Unknown fields return null (callers keep their own fallback).
 */
export function getEffectiveRomRange(
  constraints: RomScenarioConstraints | null | undefined,
  canonicalKey: string | null | undefined,
  fieldKey: string | null | undefined,
): RomRangeDeg | null {
  const def = getRomFieldDefinition(canonicalKey, fieldKey);
  if (!def) return null;
  return resolveAvailableRange(def.range, getRomFieldConstraint(constraints, canonicalKey, fieldKey));
}

/** Tolerance (deg) for the painful-arc test. Pain-limited ROM is usually
 *  authored with the arc ENDING at the available limit; the clamp stops the
 *  bone exactly there, but the angle read back off the recomposed quaternion
 *  can land a hair past the boundary, which would silently drop the pain
 *  signal at the exact position it matters most. */
const PAINFUL_ARC_TOLERANCE_DEG = 0.25;

/** True when `value` sits inside the constraint's painful arc (inclusive,
 *  with a small readback tolerance at the boundaries). */
export function isInRomPainfulArc(
  value: number,
  constraint: RomFieldConstraint | null | undefined,
): boolean {
  const arc = constraint?.painfulArc;
  if (!arc || !Number.isFinite(value)) return false;
  const lo = Math.min(arc.min, arc.max) - PAINFUL_ARC_TOLERANCE_DEG;
  const hi = Math.max(arc.min, arc.max) + PAINFUL_ARC_TOLERANCE_DEG;
  return value >= lo && value <= hi;
}

/**
 * Everything a readout needs to draw one constrained field: the normative
 * track, the available window inside it, painful-arc bounds, and where a
 * live value sits (0–100% along the NORMATIVE track, so the available window
 * and the marker share one coordinate system).
 */
export interface RomConstraintView {
  field: RomFieldDefinition;
  normativeRange: RomRangeDeg;
  availableRange: RomRangeDeg;
  /** True when the scenario actually narrows this field. */
  restricted: boolean;
  constraint: RomFieldConstraint | undefined;
  /** Percent positions along the normative track (0–100). */
  availableMinPercent: number;
  availableMaxPercent: number;
  painfulArc: RomRangeDeg | null;
  painfulArcMinPercent: number | null;
  painfulArcMaxPercent: number | null;
}

/** Build the readout view for one joint field, or null if the field is unknown. */
export function getRomConstraintView(
  constraints: RomScenarioConstraints | null | undefined,
  canonicalKey: string | null | undefined,
  fieldKey: string | null | undefined,
): RomConstraintView | null {
  const field = getRomFieldDefinition(canonicalKey, fieldKey);
  if (!field) return null;
  const constraint = getRomFieldConstraint(constraints, canonicalKey, fieldKey);
  const availableRange = resolveAvailableRange(field.range, constraint);
  const pct = (v: number) => toPercent(v, field.range);
  const arc = constraint?.painfulArc ?? null;
  return {
    field,
    normativeRange: field.range,
    availableRange,
    restricted:
      availableRange.min > field.range.min + 1e-9 || availableRange.max < field.range.max - 1e-9,
    constraint,
    availableMinPercent: pct(availableRange.min),
    availableMaxPercent: pct(availableRange.max),
    painfulArc: arc,
    painfulArcMinPercent: arc ? pct(Math.min(arc.min, arc.max)) : null,
    painfulArcMaxPercent: arc ? pct(Math.max(arc.min, arc.max)) : null,
  };
}

function toPercent(value: number, range: RomRangeDeg): number {
  const span = range.max - range.min;
  if (!Number.isFinite(span) || Math.abs(span) < 1e-9) return 50;
  return Math.max(0, Math.min(100, ((value - range.min) / span) * 100));
}
