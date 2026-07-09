/**
 * Pose-engine types — the pose-relevant subset extracted from the
 * body-chart `types.ts`. Pure type/const declarations, no runtime imports,
 * no pain-finding/EMR dependencies.
 */

/** Which canonical rest pose the rig loads into. */
export type ModelPose = 'tpose' | 'anatomic';

/** Per-bone local quaternion override, keyed by canonical bone key
 *  (e.g. 'L_UpperArm', 'Hips'). Stored relative to parent so it survives
 *  skeleton reload. Empty `bones` means "anatomic default".
 *
 *  `positions` optionally captures local translations for the same bones —
 *  used when a joint is shifted in translate mode. Most poses are
 *  rotation-only, so it's optional. */
export interface CustomPose {
  variant: string;
  bones: Record<string, [number, number, number, number]>;
  positions?: Record<string, [number, number, number]>;
  /** Anatomic-baseline schema version this pose was authored against. Saved
   *  poses with a missing/mismatched schemaVersion are dropped on load. */
  schemaVersion?: string;
}

/** Bumped whenever the anatomic baseline (boneQuaternions / targets in
 *  bodyVariants.ts) changes in a way that invalidates saved CustomPose. */
export const POSE_SCHEMA_VERSION = 'cc-2026-04-29-male-default';

/** Clinical joint-angle readout for a pose. Computed from the live
 *  skeleton. Keys are canonical bone keys; values are joint-specific angle
 *  sets (e.g. 'L_Forearm' → { elbowFlexion: 90 }). Degrees, sign-conventional
 *  per services/jointAngles.ts. */
export interface JointAngleReport {
  at: string;
  variant: string;
  joints: Record<string, Record<string, number>>;
}

/** Fixed camera framing presets. */
export type PainBodyView = 'front' | 'back' | 'left' | 'right';

/** Body laterality. */
export type BodySide = '' | 'left' | 'right' | 'bilateral' | 'midline';

/** Plain 3D vector (serialization-friendly). */
export interface PainBodyVector3 {
  x: number;
  y: number;
  z: number;
}

/** Movement clip identifiers the rig can be driven with. */
export type MovementClipId =
  | 'stand'
  | 'sit'
  | 'walk'
  | 'walk-backward'
  | 'walk-strafe-left'
  | 'walk-strafe-right'
  | 'crouch-walk'
  | 'limp'
  | 'long-sit'
  | 'jog'
  | 'run'
  | 'walk-relaxed'
  | 'walk-elder'
  | 'walk-elderly'
  | 'walk-elderly-wobble'
  | 'catwalk'
  | 'aerobic-dance'
  | 'idle'
  | 'idle-passenger'
  | 'left-knee-extension'
  | 'right-knee-extension'
  | 'sandbox';
