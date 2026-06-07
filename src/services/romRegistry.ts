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
    'warningMarginDeg' | 'goniometerOffsetDeg' | 'neutralSeparationDeg'
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
    ],
  },
  {
    canonicalKey: 'L_Shoulder',
    label: 'L Scapula',
    fields: [
      field('upRotation', 'Up rot', 'Up', 'Down', { min: -5, max: 60 }, 'frontal'),
      field('scapularTilt', 'Tilt', 'Post', 'Ant', { min: -10, max: 40 }, 'sagittal'),
      field('protraction', 'Protract', 'Pro', 'Ret', { min: -30, max: 30 }, 'transverse'),
    ],
  },
  {
    canonicalKey: 'R_Shoulder',
    label: 'R Scapula',
    fields: [
      field('upRotation', 'Up rot', 'Up', 'Down', { min: -5, max: 60 }, 'frontal'),
      field('scapularTilt', 'Tilt', 'Post', 'Ant', { min: -10, max: 40 }, 'sagittal'),
      field('protraction', 'Protract', 'Pro', 'Ret', { min: -30, max: 30 }, 'transverse'),
    ],
  },
  {
    canonicalKey: 'L_UpperArm',
    label: 'L Shoulder',
    fields: [
      field('shoulderFlexion', 'Flex', 'Flex', 'Ext', { min: -60, max: 180 }, 'sagittal'),
      field('shoulderAbduction', 'Abd', 'Abd', 'Add', { min: -50, max: 180 }, 'frontal'),
      field('shoulderRotation', 'Rotate', 'Int', 'Ext', { min: -90, max: 70 }, 'transverse'),
    ],
  },
  {
    canonicalKey: 'R_UpperArm',
    label: 'R Shoulder',
    fields: [
      field('shoulderFlexion', 'Flex', 'Flex', 'Ext', { min: -60, max: 180 }, 'sagittal'),
      field('shoulderAbduction', 'Abd', 'Abd', 'Add', { min: -50, max: 180 }, 'frontal'),
      field('shoulderRotation', 'Rotate', 'Int', 'Ext', { min: -90, max: 70 }, 'transverse'),
    ],
  },
  {
    canonicalKey: 'L_Forearm',
    label: 'L Elbow',
    fields: [
      field('elbowFlexion', 'Flex', 'Flex', 'Ext', { min: 0, max: 150 }, 'sagittal', {
        warningMarginDeg: 8,
      }),
      field('forearmRotation', 'Pro/Sup', 'Sup', 'Pro', { min: -80, max: 80 }, 'transverse'),
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
      field('forearmRotation', 'Pro/Sup', 'Sup', 'Pro', { min: -80, max: 80 }, 'transverse'),
      field('elbowDeviation', 'Var/Valg', 'Valg', 'Var', { min: -5, max: 15 }, 'frontal'),
    ],
  },
  {
    canonicalKey: 'L_Hand',
    label: 'L Wrist',
    fields: [
      field('wristFlexion', 'Flex', 'Flex', 'Ext', { min: -70, max: 80 }, 'sagittal'),
      field('proSup', 'Pro/Sup', 'Sup', 'Pro', { min: -80, max: 80 }, 'transverse'),
      field('wristDeviation', 'Dev', 'Radial', 'Ulnar', { min: -30, max: 20 }, 'frontal'),
    ],
  },
  {
    canonicalKey: 'R_Hand',
    label: 'R Wrist',
    fields: [
      field('wristFlexion', 'Flex', 'Flex', 'Ext', { min: -70, max: 80 }, 'sagittal'),
      field('proSup', 'Pro/Sup', 'Sup', 'Pro', { min: -80, max: 80 }, 'transverse'),
      field('wristDeviation', 'Dev', 'Radial', 'Ulnar', { min: -30, max: 20 }, 'frontal'),
    ],
  },
  {
    canonicalKey: 'L_UpLeg',
    label: 'L Hip',
    fields: [
      field('hipFlexion', 'Flex', 'Flex', 'Ext', { min: -30, max: 120 }, 'sagittal'),
      field('hipAbduction', 'Abd', 'Abd', 'Add', { min: -30, max: 45 }, 'frontal'),
      field('hipRotation', 'Rotate', 'Int', 'Ext', { min: -45, max: 45 }, 'transverse'),
    ],
  },
  {
    canonicalKey: 'R_UpLeg',
    label: 'R Hip',
    fields: [
      field('hipFlexion', 'Flex', 'Flex', 'Ext', { min: -30, max: 120 }, 'sagittal'),
      field('hipAbduction', 'Abd', 'Abd', 'Add', { min: -30, max: 45 }, 'frontal'),
      field('hipRotation', 'Rotate', 'Int', 'Ext', { min: -45, max: 45 }, 'transverse'),
    ],
  },
  {
    canonicalKey: 'L_Leg',
    label: 'L Knee',
    fields: [
      field('kneeFlexion', 'Flex', 'Flex', 'Ext', { min: 0, max: 140 }, 'sagittal', {
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
      field('kneeFlexion', 'Flex', 'Flex', 'Ext', { min: 0, max: 140 }, 'sagittal', {
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
];

const ROM_JOINT_BY_KEY = new Map(ROM_JOINT_ROWS.map((row) => [row.canonicalKey, row]));
const ROM_FIELD_BY_ID = new Map<string, RomFieldDefinition>();
for (const row of ROM_JOINT_ROWS) {
  for (const item of row.fields) {
    ROM_FIELD_BY_ID.set(`${row.canonicalKey}.${item.key}`, item);
  }
}

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
  return ROM_FIELD_BY_ID.get(`${canonicalKey}.${fieldKey}`);
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
  const classification = classifyRomValue(value, fieldDef);
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
