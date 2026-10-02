import { UPPER_ARM_CLINICAL_RANGES } from '../anatomy/upperArmJointFrame.mjs';
import { SCAPULAR_GIRDLE_RANGES } from '../anatomy/scapularGirdleProxy.mjs';

export type RomPlane = 'sagittal' | 'frontal' | 'transverse';
export type RomStatus = 'neutral' | 'within' | 'near-limit' | 'outside';
export type RomLimitSide = 'min' | 'max' | null;

export interface RomRangeDeg {
  min: number;
  max: number;
}

export interface RomFieldDefinition {
  key: string;
  label: string;
  positiveAs: string;
  negativeAs: string;
  range: RomRangeDeg;
  plane: RomPlane;
  color: string;
  colorHex: number;
  warningMarginDeg?: number;
  goniometerOffsetDeg?: number;
  neutralSeparationDeg?: number;
  /** Closed-chain / WEIGHT-BEARING max for this field, when it differs from the
   *  open-chain AROM `range.max`. Ankle dorsiflexion is the canonical case: the
   *  seated open-chain AROM norm is ~20°, but a weight-bearing lunge/squat (the
   *  shin advancing over a planted foot) reaches ~35° (WBLT). Consumed by
   *  `resolveCommandTarget` only when the target is resolved under a planted
   *  (closed-chain) stance; a scenario restriction still tightens it, so a
   *  reduced-dorsiflexion fault is expressed by constraining below this. */
  weightBearingMax?: number;
  /** A rotation about the thigh's own length whose band also holds as the
   *  seated norm is measured: from the thigh flexed and then carried out to the
   *  side (or across the body) without turning. The band then follows where
   *  the thigh points ({@link thighRotationRange}). Only the hip's rotation. */
  seatedFrame?: boolean;
}

/** Where the thigh points, in this engine's hip fields (registry convention:
 *  + flexion, + abduction away from the midline). */
export interface ThighSwing {
  flexionDeg: number;
  abductionDeg: number;
}

export interface RomJointDefinition {
  canonicalKey: string;
  label: string;
  fields: RomFieldDefinition[];
}

export interface RomFieldState {
  value: number;
  rounded: number;
  status: RomStatus;
  limitSide: RomLimitSide;
  valuePercent: number;
  zeroPercent: number;
  rangeText: string;
  outOfRangeByDeg: number;
}

const PLANE_COLORS: Record<RomPlane, { css: string; hex: number }> = {
  sagittal: { css: '#ef4444', hex: 0xef4444 },
  transverse: { css: '#22c55e', hex: 0x22c55e },
  frontal: { css: '#3b82f6', hex: 0x3b82f6 },
};

function field(
  key: string,
  label: string,
  positiveAs: string,
  negativeAs: string,
  range: RomRangeDeg,
  plane: RomPlane,
  options: Pick<
    RomFieldDefinition,
    'warningMarginDeg' | 'goniometerOffsetDeg' | 'neutralSeparationDeg' | 'weightBearingMax' | 'seatedFrame'
  > = {},
): RomFieldDefinition {
  const color = PLANE_COLORS[plane];
  return {
    key,
    label,
    positiveAs,
    negativeAs,
    range,
    plane,
    color: color.css,
    colorHex: color.hex,
    ...options,
  };
}

export const ROM_JOINT_ROWS: RomJointDefinition[] = [
  {
    canonicalKey: 'Hips',
    label: 'Pelvis',
    fields: [
      field('anteriorTilt', 'Tilt', 'Anterior', 'Posterior', { min: -30, max: 30 }, 'sagittal'),
      field('lateralTilt', 'Lateral', 'Left up', 'Right up', { min: -20, max: 20 }, 'frontal'),
      field('rotation', 'Rotate', 'Toward L', 'Toward R', { min: -30, max: 30 }, 'transverse'),
    ],
  },
  {
    // Lumbar (Waist rel pelvis). AROM per AAOS / Norkin & White — verify live.
    canonicalKey: 'Spine_Lower',
    label: 'Lumbar',
    fields: [
      field('flexion', 'Flex', 'Flex', 'Ext', { min: -25, max: 60 }, 'sagittal'),
      field('lateralTilt', 'Lateral', 'Left', 'Right', { min: -25, max: 25 }, 'frontal'),
      field('rotation', 'Rotate', 'Toward L', 'Toward R', { min: -10, max: 10 }, 'transverse'),
    ],
  },
  {
    // Thoracic region (Spine01+Spine02 combined). AROM per AAOS — verify live.
    canonicalKey: 'Spine_Upper',
    label: 'Thoracic',
    fields: [
      field('flexion', 'Flex', 'Flex', 'Ext', { min: -25, max: 40 }, 'sagittal'),
      field('lateralTilt', 'Lateral', 'Left', 'Right', { min: -25, max: 25 }, 'frontal'),
      field('rotation', 'Rotate', 'Toward L', 'Toward R', { min: -35, max: 35 }, 'transverse'),
    ],
  },
  {
    // Cervical (whole neck). AROM per AAOS / Norkin & White — verify live.
    canonicalKey: 'Neck',
    label: 'Cervical',
    fields: [
      field('flexion', 'Flex', 'Flex', 'Ext', { min: -60, max: 50 }, 'sagittal'),
      field('lateralTilt', 'Lateral', 'Left', 'Right', { min: -45, max: 45 }, 'frontal'),
      field('rotation', 'Rotate', 'Toward L', 'Toward R', { min: -80, max: 80 }, 'transverse'),
      // HEAD PROTRACTION / RETRACTION — forward-head posture, the sagittal
      // TRANSLATION of the head rather than a bend of the neck. Measured as the
      // half-difference of the two cervical segments (lower flexion against
      // upper extension), which is exactly orthogonal to `flexion` above (their
      // SUM). Band is deliberately narrower than the flexion ROM: this is a
      // posture, not an excursion, and beyond ~20° the two segments are being
      // wrung against each other rather than translating the head.
      field('protraction', 'Protract', 'Pro', 'Ret', { min: -20, max: 20 }, 'sagittal'),
    ],
  },
  {
    canonicalKey: 'L_Shoulder',
    label: 'L Scapula',
    fields: [
      field('upRotation', 'Up rot', 'Up', 'Down', { ...SCAPULAR_GIRDLE_RANGES.upRotation }, 'frontal'),
      field('scapularTilt', 'Tilt', 'Post', 'Ant', { ...SCAPULAR_GIRDLE_RANGES.scapularTilt }, 'sagittal'),
      field('protraction', 'Protract', 'Pro', 'Ret', { ...SCAPULAR_GIRDLE_RANGES.protraction }, 'transverse'),
    ],
  },
  {
    canonicalKey: 'R_Shoulder',
    label: 'R Scapula',
    fields: [
      field('upRotation', 'Up rot', 'Up', 'Down', { ...SCAPULAR_GIRDLE_RANGES.upRotation }, 'frontal'),
      field('scapularTilt', 'Tilt', 'Post', 'Ant', { ...SCAPULAR_GIRDLE_RANGES.scapularTilt }, 'sagittal'),
      field('protraction', 'Protract', 'Pro', 'Ret', { ...SCAPULAR_GIRDLE_RANGES.protraction }, 'transverse'),
    ],
  },
  {
    canonicalKey: 'L_UpperArm',
    label: 'L Shoulder',
    fields: [
      field('shoulderFlexion', 'Flex', 'Flex', 'Ext', { ...UPPER_ARM_CLINICAL_RANGES.shoulderFlexion }, 'sagittal'),
      field('shoulderAbduction', 'Abd', 'Abd', 'Add', { ...UPPER_ARM_CLINICAL_RANGES.shoulderAbduction }, 'frontal'),
      field('shoulderRotation', 'Rotate', 'Int', 'Ext', { ...UPPER_ARM_CLINICAL_RANGES.shoulderRotation }, 'transverse'),
    ],
  },
  {
    canonicalKey: 'R_UpperArm',
    label: 'R Shoulder',
    fields: [
      field('shoulderFlexion', 'Flex', 'Flex', 'Ext', { ...UPPER_ARM_CLINICAL_RANGES.shoulderFlexion }, 'sagittal'),
      field('shoulderAbduction', 'Abd', 'Abd', 'Add', { ...UPPER_ARM_CLINICAL_RANGES.shoulderAbduction }, 'frontal'),
      field('shoulderRotation', 'Rotate', 'Int', 'Ext', { ...UPPER_ARM_CLINICAL_RANGES.shoulderRotation }, 'transverse'),
    ],
  },
  {
    canonicalKey: 'L_Forearm',
    label: 'L Elbow',
    fields: [
      field('elbowFlexion', 'Flex', 'Flex', 'Ext', { min: 0, max: 150 }, 'sagittal', {
        warningMarginDeg: 8,
      }),
      field('forearmRotation', 'Pro/Sup', 'Sup', 'Pro', { min: -90, max: 90 }, 'transverse'),
      field('elbowDeviation', 'Var/Valg', 'Valg', 'Var', { min: -5, max: 15 }, 'frontal'),
    ],
  },
  {
    canonicalKey: 'R_Forearm',
    label: 'R Elbow',
    fields: [
      field('elbowFlexion', 'Flex', 'Flex', 'Ext', { min: 0, max: 150 }, 'sagittal', {
        warningMarginDeg: 8,
      }),
      field('forearmRotation', 'Pro/Sup', 'Sup', 'Pro', { min: -90, max: 90 }, 'transverse'),
      field('elbowDeviation', 'Var/Valg', 'Valg', 'Var', { min: -5, max: 15 }, 'frontal'),
    ],
  },
  {
    canonicalKey: 'L_Hand',
    label: 'L Wrist',
    fields: [
      field('wristFlexion', 'Flex', 'Flex', 'Ext', { min: -70, max: 80 }, 'sagittal'),
      field('proSup', 'Pro/Sup', 'Sup', 'Pro', { min: -90, max: 90 }, 'transverse'),
      field('wristDeviation', 'Dev', 'Radial', 'Ulnar', { min: -30, max: 20 }, 'frontal'),
    ],
  },
  {
    canonicalKey: 'R_Hand',
    label: 'R Wrist',
    fields: [
      field('wristFlexion', 'Flex', 'Flex', 'Ext', { min: -70, max: 80 }, 'sagittal'),
      field('proSup', 'Pro/Sup', 'Sup', 'Pro', { min: -90, max: 90 }, 'transverse'),
      field('wristDeviation', 'Dev', 'Radial', 'Ulnar', { min: -30, max: 20 }, 'frontal'),
    ],
  },
  {
    canonicalKey: 'L_UpLeg',
    label: 'L Hip',
    fields: [
      field('hipFlexion', 'Flex', 'Flex', 'Ext', { min: -30, max: 120 }, 'sagittal'),
      field('hipAbduction', 'Abd', 'Abd', 'Add', { min: -30, max: 45 }, 'frontal'),
      field('hipRotation', 'Rotate', 'Int', 'Ext', { min: -45, max: 45 }, 'transverse', { seatedFrame: true }),
    ],
  },
  {
    canonicalKey: 'R_UpLeg',
    label: 'R Hip',
    fields: [
      field('hipFlexion', 'Flex', 'Flex', 'Ext', { min: -30, max: 120 }, 'sagittal'),
      field('hipAbduction', 'Abd', 'Abd', 'Add', { min: -30, max: 45 }, 'frontal'),
      field('hipRotation', 'Rotate', 'Int', 'Ext', { min: -45, max: 45 }, 'transverse', { seatedFrame: true }),
    ],
  },
  {
    canonicalKey: 'L_Leg',
    label: 'L Knee',
    fields: [
      field('kneeFlexion', 'Flex', 'Flex', 'Ext', { min: -15, max: 140 }, 'sagittal', {
        warningMarginDeg: 8,
      }),
      field('kneeRotation', 'Rotate', 'Int', 'Ext', { min: -35, max: 25 }, 'transverse'),
      field('kneeDeviation', 'Var/Valg', 'Valg', 'Var', { min: -5, max: 5 }, 'frontal'),
    ],
  },
  {
    canonicalKey: 'R_Leg',
    label: 'R Knee',
    fields: [
      field('kneeFlexion', 'Flex', 'Flex', 'Ext', { min: -15, max: 140 }, 'sagittal', {
        warningMarginDeg: 8,
      }),
      field('kneeRotation', 'Rotate', 'Int', 'Ext', { min: -35, max: 25 }, 'transverse'),
      field('kneeDeviation', 'Var/Valg', 'Valg', 'Var', { min: -5, max: 5 }, 'frontal'),
    ],
  },
  {
    canonicalKey: 'L_Foot',
    label: 'L Ankle',
    fields: [
      field('ankleFlexion', 'Flex', 'Dorsi', 'Plantar', { min: -50, max: 20 }, 'sagittal', {
        neutralSeparationDeg: -90,
        // Weight-bearing DF (WBLT norm) — the shin advancing over a planted foot
        // in a squat/lunge reaches ~35°, vs the ~20° seated open-chain AROM.
        weightBearingMax: 35,
      }),
      field('ankleInversion', 'Invert', 'Inv', 'Ev', { min: -15, max: 35 }, 'frontal'),
      field('ankleAbduction', 'Abd/Add', 'Abd', 'Add', { min: -20, max: 15 }, 'transverse'),
    ],
  },
  {
    canonicalKey: 'R_Foot',
    label: 'R Ankle',
    fields: [
      field('ankleFlexion', 'Flex', 'Dorsi', 'Plantar', { min: -50, max: 20 }, 'sagittal', {
        neutralSeparationDeg: -90,
        // Weight-bearing DF (WBLT norm) — the shin advancing over a planted foot
        // in a squat/lunge reaches ~35°, vs the ~20° seated open-chain AROM.
        weightBearingMax: 35,
      }),
      field('ankleInversion', 'Invert', 'Inv', 'Ev', { min: -15, max: 35 }, 'frontal'),
      field('ankleAbduction', 'Abd/Add', 'Abd', 'Add', { min: -20, max: 15 }, 'transverse'),
    ],
  },
  {
    // Forefoot / great-toe MTP (ToeBase). AROM per AAOS — verify live.
    canonicalKey: 'L_Toes',
    label: 'L Toes',
    fields: [field('toeFlexion', 'MTP', 'Ext', 'Flex', { min: -40, max: 70 }, 'sagittal')],
  },
  {
    canonicalKey: 'R_Toes',
    label: 'R Toes',
    fields: [field('toeFlexion', 'MTP', 'Ext', 'Flex', { min: -40, max: 70 }, 'sagittal')],
  },
  // Fingers — composite total-flexion (curl) per digit. Geometric, 0 when
  // straight, negative into extension.
  //
  // THE THUMB IS CAPPED LOWER, and separately, because it is not a finger: it has
  // TWO phalanges and its joints are CMC / MP / IP. The composite is realized
  // across them with the same shares, so the MP takes FINGER_PIP_SHARE of the
  // commanded value — which means the fingers' 160° ceiling would drive the thumb
  // MP past 100° against an AAOS normal of 50–60°. The engine used to return
  // 'complied' for that, and the calibration gate asserted commanded == measured
  // all the way to 160, so the correctness contract was certifying an
  // anatomically impossible thumb. 85 is measurement-derived: the MP reaches ~55°
  // there and crosses 60° near commanded 92.
  ...(['L_', 'R_'] as const).flatMap((side) =>
    (
      [
        ['Thumb1', 'Thumb', 85],
        ['Index1', 'Index', 160],
        ['Mid1', 'Mid', 160],
        ['Ring1', 'Ring', 160],
        ['Pinky1', 'Pinky', 160],
      ] as const
    ).map(([key, label, max]) => ({
      canonicalKey: `${side}${key}`,
      label: `${side === 'L_' ? 'L' : 'R'} ${label}`,
      fields: [field('fingerFlexion', 'Curl', 'Flex', 'Ext', { min: 0, max }, 'sagittal')],
    })),
  ),
];

const ROM_JOINT_BY_KEY = new Map(ROM_JOINT_ROWS.map((row) => [row.canonicalKey, row]));
/** Each joint's fields by key. Keyed in two levels rather than by the joined
 *  `joint.field` id: every ROM clamp looks fields up several times per IK pass,
 *  and building that string each time was a tenth of a hand-reach settle. */
const ROM_FIELD_BY_JOINT = new Map<string, Map<string, RomFieldDefinition>>(
  ROM_JOINT_ROWS.map((row) => [row.canonicalKey, new Map(row.fields.map((item) => [item.key, item]))]),
);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeValue(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function getRomJointDefinition(
  canonicalKey: string | null | undefined,
): RomJointDefinition | undefined {
  return canonicalKey ? ROM_JOINT_BY_KEY.get(canonicalKey) : undefined;
}

export function getRomFieldDefinition(
  canonicalKey: string | null | undefined,
  fieldKey: string | null | undefined,
): RomFieldDefinition | undefined {
  if (!canonicalKey || !fieldKey) return undefined;
  return ROM_FIELD_BY_JOINT.get(canonicalKey)?.get(fieldKey);
}

/**
 * The ROM band that actually applies to a target, given whether the segment is
 * WEIGHT-BEARING (closed chain).
 *
 * A planted foot reaches materially more dorsiflexion than a seated one — the
 * shin advancing over the foot in a squat/lunge hits ~35° against the ~20°
 * open-chain AROM — so a field may publish a larger `weightBearingMax`. Anything
 * asking "is this angle inside its band?" has to make the same call, or a
 * perfectly legal weight-bearing squat reads as an out-of-range violation.
 *
 * This rule used to live inline inside movementCommand's target resolution,
 * which meant the CLAMP honoured weight-bearing and the validity GATE did not:
 * the gate asserted against `range.max` alone and flagged the shipped squat
 * template's authored 32° ankle as "resolution should have clamped this" — a
 * false accusation of a bug in the clamp, produced by a second opinion about
 * the band. One rule, both callers.
 *
 * The same goes for the hip's rotation, whose band follows where the thigh
 * points (`thigh`: the flexion and abduction the same keyframe or pose gives
 * the hip; see {@link thighRotationRange}). Omitted, it is the plain band.
 */
export function effectiveRomRange(
  def: Pick<RomFieldDefinition, 'range' | 'weightBearingMax' | 'seatedFrame'>,
  opts: { weightBearing?: boolean; thigh?: ThighSwing } = {},
): RomRangeDeg {
  const range =
    opts.weightBearing && def.weightBearingMax != null && def.weightBearingMax > def.range.max
      ? { ...def.range, max: def.weightBearingMax }
      : def.range;
  return def.seatedFrame && opts.thigh ? thighRotationRange(range, opts.thigh) : range;
}

const RAD = Math.PI / 180;
/**
 * How far (deg) the thigh swings out of hanging straight before the seated
 * frame takes over from the neutral one: not at all up to `from`, then in a
 * straight line to full at `to`, so the band is continuous. Standing and
 * walking keep the plain band (a turning walk's planted hip reaches 50° of
 * rotation with the thigh swung 22°, and the foot-plant IK clamps it there);
 * the figure-4 swings the thigh 40° or more.
 */
const SEATED_FRAME_SWING_DEG = { from: 25, to: 40 };

/**
 * How much of a thigh's position this engine books as rotation about the
 * thigh's own length (deg; + when the thigh opens out to the side, − when it
 * is carried across the body), although nothing turned it: Codman's paradox,
 * for the hip.
 *
 * The engine aims the thigh by the shortest arc from hanging straight (its
 * flexion and abduction) and then turns it about its length (hipRotation). A
 * thigh flexed and then carried out to the side, the way the figure-4 (FABER),
 * the frog position and sitting cross-legged are reached, arrives turned by
 * exactly the angle it was carried out, whatever the flexion: flexed 90° and
 * opened 45°, the engine reads 45° of external rotation that no one applied.
 * The seated rotation norms are measured from that flexed thigh, so this is
 * how far they sit from the engine's zero. It takes over as the thigh swings
 * out of hanging straight ({@link SEATED_FRAME_SWING_DEG}), and fades back out
 * as a thigh opened past the side is carried behind (extension, where the
 * thigh is not flexed).
 */
export function thighCodmanTwistDeg(thigh: ThighSwing): number {
  const f = thigh.flexionDeg * RAD;
  const a = thigh.abductionDeg * RAD;
  // The thigh's direction as the hip composes it (composeHipDelta): out to the
  // side sin(a), forward cos(a)·sin(f), down cos(a)·cos(f).
  const out = Math.sin(a);
  const forward = Math.cos(a) * Math.sin(f);
  const down = Math.cos(a) * Math.cos(f);
  const swingDeg = Math.acos(clamp(down, -1, 1)) / RAD;
  // Where the knee points, seen from above: 0 straight ahead, +90 out to the
  // side, −90 across the body; past the side, the thigh is going back.
  const opening = Math.atan2(out, forward) / RAD;
  const carried = Math.abs(opening) > 90 ? Math.sign(opening) * (180 - Math.abs(opening)) : opening;
  const { from, to } = SEATED_FRAME_SWING_DEG;
  return carried * clamp((swingDeg - from) / (to - from), 0, 1);
}

/**
 * The hip's rotation band for a thigh pointing where `thigh` says: a rotation
 * is in range if it is within the norm from the engine's zero (the thigh
 * hanging straight and turned neither way) or from the flexed thigh carried
 * out without turning (the seated frame; {@link thighCodmanTwistDeg}). So a
 * thigh opened out may turn out further, by as far as it was opened, and one
 * carried across the body may turn in further; neither side ever narrows, and
 * a thigh in one plane (straight ahead, straight out, hanging) keeps the
 * plain band.
 *
 * Without it the band forbade what ordinary hips do: held to 45° of external
 * rotation, the figure-4's foot slid off the other knee unless that knee stayed
 * about 40 cm above the table, while hips that turn out 44° on their own lower
 * it to 11 ± 2 cm (Tsutsumi et al., Sci Rep 2022;12:6656). On the runtime
 * models the figure-4 with the knee 8 to 40 cm above the table needs 60° to
 * 105° here, which is 22° to 33° from the seated frame. + = internal, as the
 * field.
 */
export function thighRotationRange(range: RomRangeDeg, thigh: ThighSwing): RomRangeDeg {
  const twist = thighCodmanTwistDeg(thigh);
  return { min: range.min - Math.max(0, twist), max: range.max + Math.max(0, -twist) };
}

export function getRomPercent(value: number, range: RomRangeDeg): number {
  const span = range.max - range.min;
  if (!Number.isFinite(span) || Math.abs(span) < 1e-9) return 50;
  return clamp(((normalizeValue(value) - range.min) / span) * 100, 0, 100);
}

export function getRomZeroPercent(fieldDef: RomFieldDefinition): number {
  return getRomPercent(0, fieldDef.range);
}

export function getRomWarningMargin(fieldDef: RomFieldDefinition): number {
  if (fieldDef.warningMarginDeg != null) return fieldDef.warningMarginDeg;
  const span = fieldDef.range.max - fieldDef.range.min;
  return Math.min(10, Math.max(3, span * 0.08));
}

export function classifyRomValue(
  valueInput: number,
  fieldDef: RomFieldDefinition,
): Pick<RomFieldState, 'status' | 'limitSide' | 'outOfRangeByDeg'> {
  const value = normalizeValue(valueInput);
  const { min, max } = fieldDef.range;
  if (value < min) {
    return { status: 'outside', limitSide: 'min', outOfRangeByDeg: min - value };
  }
  if (value > max) {
    return { status: 'outside', limitSide: 'max', outOfRangeByDeg: value - max };
  }
  if (Math.abs(value) < 0.5) {
    return { status: 'neutral', limitSide: null, outOfRangeByDeg: 0 };
  }
  const margin = getRomWarningMargin(fieldDef);
  if (value - min <= margin) {
    return { status: 'near-limit', limitSide: 'min', outOfRangeByDeg: 0 };
  }
  if (max - value <= margin) {
    return { status: 'near-limit', limitSide: 'max', outOfRangeByDeg: 0 };
  }
  return { status: 'within', limitSide: null, outOfRangeByDeg: 0 };
}

export function getRomFieldState(valueInput: number, fieldDef: RomFieldDefinition): RomFieldState {
  const value = normalizeValue(valueInput);
  // Float32 rig transforms can read an exact authored stop back a few
  // millionths of a degree beyond its bound. Stabilize the display badge only;
  // retain the measurement below and the strict classifier for other callers.
  // This is not the larger tolerance used by trajectory acceptance tests.
  const displayRoundoffDeg = 1e-5;
  const { min, max } = fieldDef.range;
  const displayValue = Math.abs(value - min) <= displayRoundoffDeg ? min
    : Math.abs(value - max) <= displayRoundoffDeg ? max : value;
  const classification = classifyRomValue(displayValue, fieldDef);
  return {
    value,
    rounded: Math.round(value),
    valuePercent: getRomPercent(value, fieldDef.range),
    zeroPercent: getRomZeroPercent(fieldDef),
    rangeText: formatRomRange(fieldDef.range),
    ...classification,
  };
}

export function formatRomRange(range: RomRangeDeg): string {
  return `${Math.round(range.min)} to ${Math.round(range.max)} deg`;
}

export function formatRomValue(valueInput: number, fieldDef: RomFieldDefinition): string {
  const value = normalizeValue(valueInput);
  const rounded = Math.round(value);
  if (Math.abs(rounded) < 1) return '0 deg';
  const label = rounded > 0 ? fieldDef.positiveAs : fieldDef.negativeAs;
  return `${label} ${Math.abs(rounded)} deg`;
}

export function formatRomStatus(state: RomFieldState): string {
  if (state.status === 'outside') return 'out';
  if (state.status === 'near-limit') return 'near';
  return '';
}
