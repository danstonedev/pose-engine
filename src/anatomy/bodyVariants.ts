import type { MovementClipId } from '../types';

export type BodyVariantId = 'male' | 'female';
export type SkeletonKind = 'cc';

/**
 * Canonical bone tokens used by the anatomy classifier. Variant-specific
 * bone names get normalized into one of these via BoneNameMap.
 */
export type CanonicalBone =
  | 'Head'
  | 'HeadTop'
  | 'Neck'
  | 'Shoulder'
  | 'UpperArm'
  | 'Forearm'
  | 'Hand'
  | 'Spine_Upper'
  | 'Spine_Mid'
  | 'Spine_Lower'
  | 'Hips'
  | 'UpLeg'
  | 'Leg'
  | 'Foot'
  | 'Toes';

export type FingerToken = 'HandThumb' | 'HandIndex' | 'HandMiddle' | 'HandRing' | 'HandPinky';

export interface BoneNameMap {
  /** Stripped from the start of every bone name before any other processing. */
  prefix: RegExp;
  /** Side-prefix patterns; matched against the post-`prefix`-stripped name. */
  sidePrefix: { left: RegExp; right: RegExp };
  /**
   * Variant-specific bone substrings that map to each canonical token.
   * The first match wins, so list more specific names before more general ones.
   */
  core: Record<CanonicalBone, string[]>;
  /**
   * Regex patterns matched against the post-prefix, post-side-strip core name
   * to detect a finger bone. Captured group 1 (if present) selects the finger.
   */
  fingers: Array<{ pattern: RegExp; token: FingerToken }>;
}

/**
 * World-space pose target. The bone's long axis (rest direction = vector from
 * bone position to its first child) is rotated to point at `worldDir`. Optional
 * `twist` rotates around that new world-space direction afterward.
 *
 * Use this for new rigs where the local-axis convention isn't known in advance
 * — it's robust to Blender's FBX axis swaps and to any rest-pose orientation.
 */
export interface AnatomicPoseTarget {
  worldDir: [number, number, number];
  /** Twist about the bone's new long axis in radians. Positive = right-hand rule. */
  twist?: number;
}

export interface AnatomicPose {
  /**
   * Canonical-bone-keyed (with optional 'L_' / 'R_' prefix for sided bones)
   * Euler triple in radians, **added** to the bone's existing rotation.
   * Currently unused by CC variants (which calibrate via `targets` + per-bone
   * `boneQuaternions`), kept as a fallback path for future rigs that need
   * legacy-style local-Euler offsets.
   */
  rotations: Record<string, [number, number, number]>;
  /**
   * World-space target directions per bone. When present, takes precedence over
   * `rotations`. Process order is parent→child within the limb chain.
   */
  targets?: Record<string, AnatomicPoseTarget>;
  /**
   * Absolute local-quaternion overrides per canonical bone key (e.g. 'L_UpperArm').
   * Applied AFTER `targets` / `rotations`, overwriting that bone's local rotation
   * entirely. Any key starting with `L_` whose mirror partner `R_…` is omitted is
   * auto-mirrored via (x, -y, -z, w) — the CC rig's natural L/R local-frame
   * convention. Used for hand-tuned per-bone calibration captured from the
   * dev-console pose recorder.
   */
  boneQuaternions?: Record<string, [number, number, number, number]>;
  rootScale: number;
  rootYOffset: number;
}

export interface BodyVariantConfig {
  id: BodyVariantId;
  label: string;
  modelUrl: (base: string) => string;
  skeleton: SkeletonKind;
  boneNameMap: BoneNameMap;
  /** Selects which generated atlas module to load. */
  atlasModuleId: 'cc';
  movementClipIds: MovementClipId[];
  pose: AnatomicPose;
  /** Runtime model height in world units after the root pose scale is applied. */
  referenceHeightWorld: number;
  /**
   * Mosteller-calibrated body surface area (cm²) for the variant's reference
   * stature, used as the BSA target when no patient profile is available.
   * The runtime mesh is decimated (~28k triangles), so its raw geometric
   * surface area (~2,100 cm² for the male rig) is far smaller than a real
   * human's; this value rescales the painMetrics output to clinical norms so
   * `/about`, the workspace metrics panel, and exports all read realistic cm²
   * even before a patient profile is entered.
   */
  defaultBodySurfaceAreaCm2: number;
  paintAtlas?: BodyVariantPaintAtlasConfig;
  poseRig: PoseRigConfig;
}

/** A single draggable joint exposed to the user when Pose mode is active. */
export interface PoseRigHandle {
  /** Canonical bone key — same scheme as `AnatomicPose.rotations` keys. */
  canonicalKey: string;
  /** FK joints rotate the bone directly (swing-to-target).
   *  IK end-effectors solve a parent chain via CCDIK. */
  type: 'fk' | 'ik-effector';
  /** For ik-effector: number of parent bones included in the solve chain.
   *  Hand → 2 (Forearm + UpperArm above the hand). Foot → 2 (Leg + UpLeg).
   *  Total chain length is `chainParentCount + 1`. */
  chainParentCount?: number;
  /** Visual radius of the handle sphere in world units (auto-scales with camera). */
  handleRadius?: number;
}

export interface PoseRigConfig {
  handles: PoseRigHandle[];
}

/** Shared pose rig: full per-major-joint coverage with identical canonical
 *  keys for every variant. Bone-name-map normalization handles skeleton
 *  differences. The user clicks any joint sphere to attach the
 *  rotation/translation gimbal to that bone. */
const SHARED_POSE_RIG: PoseRigConfig = {
  handles: [
    // Spine + head — keep the pelvis root as FK because it has no usable
    // parent-bone chain, but route every other visible handle through IK so
    // the direct-drag "just move the joint" interaction works consistently.
    { canonicalKey: 'Hips', type: 'fk' },
    { canonicalKey: 'Spine_Mid', type: 'ik-effector', chainParentCount: 1 },
    { canonicalKey: 'Head', type: 'ik-effector', chainParentCount: 1 },
    // Left arm — every visible joint handle participates in the drag-to-pose
    // solve so the yellow dots all respond to the same grab-and-move affordance.
    { canonicalKey: 'L_Shoulder', type: 'ik-effector', chainParentCount: 1 },
    { canonicalKey: 'L_UpperArm', type: 'ik-effector', chainParentCount: 1 },
    { canonicalKey: 'L_Forearm', type: 'ik-effector', chainParentCount: 1 },
    { canonicalKey: 'L_Hand', type: 'ik-effector', chainParentCount: 2 },
    // Right arm
    { canonicalKey: 'R_Shoulder', type: 'ik-effector', chainParentCount: 1 },
    { canonicalKey: 'R_UpperArm', type: 'ik-effector', chainParentCount: 1 },
    { canonicalKey: 'R_Forearm', type: 'ik-effector', chainParentCount: 1 },
    { canonicalKey: 'R_Hand', type: 'ik-effector', chainParentCount: 2 },
    // Left leg — same pattern: hip stays single-bone (it's the pelvis pivot),
    // thigh / shin / foot solve their parent chains.
    { canonicalKey: 'L_UpLeg', type: 'ik-effector', chainParentCount: 1 },
    { canonicalKey: 'L_Leg', type: 'ik-effector', chainParentCount: 1 },
    { canonicalKey: 'L_Foot', type: 'ik-effector', chainParentCount: 2 },
    // Right leg
    { canonicalKey: 'R_UpLeg', type: 'ik-effector', chainParentCount: 1 },
    { canonicalKey: 'R_Leg', type: 'ik-effector', chainParentCount: 1 },
    { canonicalKey: 'R_Foot', type: 'ik-effector', chainParentCount: 2 },
  ],
};

export interface BodyVariantPaintAtlasTile {
  /** Index of this material's strip in the GLB's raw U-axis layout (U ∈
   *  [sourceMaterialIndex, sourceMaterialIndex + 1)). Used to decode local UVs
   *  before re-projecting into the runtime atlas. */
  sourceMaterialIndex: number;
  /** Destination rectangle in [0, 1]² UV space inside the runtime paint atlas.
   *  Tile area (`w × h`) is calibrated to the material's share of the
   *  mannequin's world-space surface area, so per-texel mm² stays roughly
   *  uniform across head, body, arms, legs, and small accessory materials.
   *  See scripts/measure-metrics-resolution.ts for the calibration. */
  rect: { x: number; y: number; w: number; h: number };
  topographyUrl?: (base: string) => string;
}

export interface BodyVariantPaintAtlasConfig {
  paintableMeshNames: string[];
  tilesByMaterialName: Record<string, BodyVariantPaintAtlasTile>;
}

// ── Anatomic pose calibrations ────────────────────────────────────────────────

// ── CC (Reallusion Character Creator) bone-name map ───────────────────────────

const CC_BONE_NAME_MAP: BoneNameMap = {
  prefix: /^CC_Base_/,
  sidePrefix: { left: /^L_/, right: /^R_/ },
  core: {
    Head: ['Head'],
    HeadTop: [],
    Neck: ['NeckTwist02', 'NeckTwist01'],
    Shoulder: ['Clavicle'],
    UpperArm: ['Upperarm'],
    Forearm: ['Forearm'],
    Hand: ['Hand'],
    Spine_Upper: ['Spine02'],
    Spine_Mid: ['Spine01'],
    Spine_Lower: ['Waist'],
    Hips: ['Hip'],
    UpLeg: ['Thigh'],
    Leg: ['Calf'],
    Foot: ['Foot'],
    Toes: ['ToeBase'],
  },
  fingers: [
    { pattern: /^(Finger0|Thumb)/, token: 'HandThumb' },
    { pattern: /^(Finger1|Index)/, token: 'HandIndex' },
    { pattern: /^(Finger2|Mid|Middle)/, token: 'HandMiddle' },
    { pattern: /^(Finger3|Ring)/, token: 'HandRing' },
    { pattern: /^(Finger4|Pinky)/, token: 'HandPinky' },
  ],
};

/** Calibration for the CC4 skeleton. Iterate by editing values and saving —
 * Vite HMR re-applies on the fly. Goal: arms down to ~20° abducted from rest,
 * forearms slightly pronated, palms roughly forward. */
/**
 * CC-base anatomic pose specified in world-space target directions, immune to
 * CC4/Blender's per-rig local-axis convention. Mannequin faces world -Z (toward
 * the camera by default). Model "left" is world +X (subject's left = viewer's
 * right). Down is world -Y. Forward (anterior) is world -Z.
 *
 * Targets describe where each bone's long axis should point in anatomic
 * position. Twist rotates about that target axis to bring palms forward.
 */
const CC_ANATOMIC_POSE: AnatomicPose = {
  rotations: {},
  targets: {
    // Upper arms: down with ~10° abduction so the hand clears the hip.
    L_UpperArm: { worldDir: [0.18, -0.98, 0] },
    R_UpperArm: { worldDir: [-0.18, -0.98, 0] },
    // Forearms: continue down (slight forward angle for natural elbow carry).
    // Twist supinates so the palm comes forward.
    L_Forearm: { worldDir: [0.05, -0.99, 0.08], twist: 1.5708 },
    R_Forearm: { worldDir: [-0.05, -0.99, 0.08], twist: -1.5708 },
    // Hands continue down from the wrist.
    L_Hand: { worldDir: [0, -1, 0] },
    R_Hand: { worldDir: [0, -1, 0] },
  },
  // Hand-tuned per-bone overrides captured 2026-04-29 from the dev-console
  // pose recorder. R_* keys are auto-mirrored via (x, -y, -z, w) by
  // applyAnatomicPose.
  boneQuaternions: {
    L_Shoulder: [0.02588617703028504, 0.03026243906534002, -0.7797707173053, 0.6247973424469029],
    L_UpperArm: [0.10570895939659541, 0.05370584790723196, 0.4975979837527436, -0.8592657006823085],
  },
  rootScale: 1.08,
  rootYOffset: -0.18,
};

// Tile rects calibrated 2026-04-30 from the male variant's skin-material
// world surface areas after intentionally collapsing accessory materials out of
// the paint atlas (body 30.40%, leg 36.65%, arm 21.92%, head 10.78%). Layout is
// a 2-row shelf where each row's height equals its renormalized share of the
// skin-only total, and each tile's width within its row is proportional to the
// material's share within that row. Nails and eyelashes still get explicit atlas
// entries so their source-material UVs can be remapped safely, but those tiles
// collapse to a zero-area sentinel and no longer consume paint texels or create
// clinically irrelevant sparse tails. Female shares are within ~3 % of male —
// the same rects apply to both variants. Re-derive via /tmp/per-material-area.mjs
// after any GLB swap.
const CC_ROW_1_HEIGHT = 0.67218;
const CC_ROW_2_HEIGHT = 1 - CC_ROW_1_HEIGHT;
const CC_ROW_2_Y = CC_ROW_1_HEIGHT;
const CC_PAINT_ATLAS: BodyVariantPaintAtlasConfig = {
  paintableMeshNames: ['CC_Base_Body', 'CC_Game_Body', 'Body', 'Mesh'],
  tilesByMaterialName: {
    Std_Skin_Body: {
      sourceMaterialIndex: 1,
      rect: { x: 0, y: 0, w: 0.453393, h: CC_ROW_1_HEIGHT },
      topographyUrl: (base) => `${base}/Line_Body_8K.png`,
    },
    Std_Skin_Leg: {
      sourceMaterialIndex: 3,
      rect: { x: 0.453393, y: 0, w: 0.546607, h: CC_ROW_1_HEIGHT },
      topographyUrl: (base) => `${base}/Line_Leg_8K.png`,
    },
    Std_Skin_Head: {
      sourceMaterialIndex: 0,
      rect: { x: 0, y: CC_ROW_2_Y, w: 0.329664, h: CC_ROW_2_HEIGHT },
      topographyUrl: (base) => `${base}/Line_Head_8K.png`,
    },
    Std_Skin_Arm: {
      sourceMaterialIndex: 2,
      rect: { x: 0.329664, y: CC_ROW_2_Y, w: 0.670336, h: CC_ROW_2_HEIGHT },
      topographyUrl: (base) => `${base}/Line_Arm_8K.png`,
    },
    Std_Nails: {
      sourceMaterialIndex: 4,
      rect: { x: 1, y: 1, w: 0, h: 0 },
    },
    Std_Eyelash: {
      sourceMaterialIndex: 5,
      rect: { x: 1, y: 1, w: 0, h: 0 },
    },
  },
};

// ── Variant registry ──────────────────────────────────────────────────────────

export const BODY_VARIANTS: Record<BodyVariantId, BodyVariantConfig> = {
  male: {
    id: 'male',
    label: 'Male',
    modelUrl: (base) => `${base}/models/painmap3D_male.runtime.glb`,
    skeleton: 'cc',
    boneNameMap: CC_BONE_NAME_MAP,
    atlasModuleId: 'cc',
    movementClipIds: [],
    pose: CC_ANATOMIC_POSE,
    referenceHeightWorld: 1.970411,
    // Mosteller BSA at 1.97 m × 80 kg → √(197 × 80 / 3600) m² ≈ 2.092 m².
    defaultBodySurfaceAreaCm2: 20920,
    paintAtlas: CC_PAINT_ATLAS,
    poseRig: SHARED_POSE_RIG,
  },
  female: {
    id: 'female',
    label: 'Female',
    modelUrl: (base) => `${base}/models/painmap3D_female.runtime.glb`,
    skeleton: 'cc',
    boneNameMap: CC_BONE_NAME_MAP,
    atlasModuleId: 'cc',
    movementClipIds: [],
    pose: CC_ANATOMIC_POSE,
    referenceHeightWorld: 1.849547,
    // Mosteller BSA at 1.85 m × 65 kg → √(185 × 65 / 3600) m² ≈ 1.828 m².
    defaultBodySurfaceAreaCm2: 18280,
    paintAtlas: CC_PAINT_ATLAS,
    poseRig: SHARED_POSE_RIG,
  },
};

export const DEFAULT_BODY_VARIANT_ID: BodyVariantId = 'male';

export function getBodyVariant(id: BodyVariantId | string | null | undefined): BodyVariantConfig {
  if (id && id in BODY_VARIANTS) return BODY_VARIANTS[id as BodyVariantId];
  return BODY_VARIANTS[DEFAULT_BODY_VARIANT_ID];
}

// ── Bone-name normalization helpers used by the classifier ───────────────────

export interface NormalizedBoneName {
  /** Raw side prefix as it appeared post-`prefix`-strip ('Left'/'Right'/null). */
  rawSide: 'Left' | 'Right' | null;
  /** Side stripped to a stable form ('Left'/'Right'/null). */
  side: 'Left' | 'Right' | null;
  /** Bone core, with prefix and side prefix removed. */
  core: string;
  /** Canonical token if the core matched one of the variant's known bones. */
  canonical: CanonicalBone | null;
  /** Finger token if the core matched a finger bone. */
  finger: FingerToken | null;
}

export function normalizeBoneNameForVariant(
  raw: string | undefined,
  map: BoneNameMap,
): NormalizedBoneName {
  const stripped = (raw ?? '').replace(map.prefix, '');
  let side: 'Left' | 'Right' | null = null;
  let core = stripped;
  if (map.sidePrefix.left.test(stripped)) {
    side = 'Left';
    core = stripped.replace(map.sidePrefix.left, '');
  } else if (map.sidePrefix.right.test(stripped)) {
    side = 'Right';
    core = stripped.replace(map.sidePrefix.right, '');
  }

  // Finger detection runs first — a "HandIndex1" bone should resolve to the
  // HandIndex finger token, not to a generic Hand match.
  let finger: FingerToken | null = null;
  for (const entry of map.fingers) {
    if (entry.pattern.test(core)) {
      finger = entry.token;
      break;
    }
  }

  let canonical: CanonicalBone | null = null;
  if (!finger) {
    for (const [token, names] of Object.entries(map.core) as Array<[CanonicalBone, string[]]>) {
      if (names.some((n) => n.length > 0 && core === n)) {
        canonical = token;
        break;
      }
    }
  }

  return { rawSide: side, side, core, canonical, finger };
}
