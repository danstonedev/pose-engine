/** Authoring intent for the 23 main body segments. This is not a claim that
 * every segment moves, nor a substitute for measured pose/contact validation. */
export const MAJOR_BODY_JOINTS = [
  'Hips', 'Spine_Lower', 'Spine_Mid', 'Spine_Upper', 'Neck_Lower', 'Neck', 'Head',
  'L_Shoulder', 'L_UpperArm', 'L_Forearm', 'L_Hand',
  'R_Shoulder', 'R_UpperArm', 'R_Forearm', 'R_Hand',
  'L_UpLeg', 'L_Leg', 'L_Foot', 'L_Toes', 'R_UpLeg', 'R_Leg', 'R_Foot', 'R_Toes',
] as const;
export type MajorBodyJoint = typeof MAJOR_BODY_JOINTS[number];
export type BodyControlRole = 'driven' | 'derived' | 'held' | 'contact' | 'free';
export interface BodyJointControl {
  role: BodyControlRole;
  /** Task-specific reason for moving, stabilizing, or allowing this segment. */
  purpose: string;
  /** The actual controller owning a companion segment. */
  source?: MajorBodyJoint;
  /** A support declared by this phase; only use contact for a solved support. */
  support?: string;
}
export interface BodyControlPhase {
  id: string;
  joints: Record<MajorBodyJoint, BodyJointControl>;
  root: {
    translation: 'support' | 'travel' | 'fixed';
    orientation: 'placement' | 'heading' | 'fixed';
  };
  supports: string[];
}

/** Explicit groups keep recipes legible without silently assigning a default
 * role to forgotten joints. Throws on omissions, duplicates or invalid links. */
export function defineBodyControl(input: Omit<BodyControlPhase, 'joints'> & {
  groups: Array<BodyJointControl & { joints: readonly MajorBodyJoint[] }>;
}): BodyControlPhase {
  const joints = {} as Record<MajorBodyJoint, BodyJointControl>;
  for (const { joints: keys, ...control } of input.groups) {
    for (const key of keys) {
      if (joints[key]) throw new Error(`Duplicate control role: ${key}`);
      joints[key] = { ...control };
    }
  }
  const phase = { id: input.id, root: { ...input.root }, supports: [...input.supports], joints };
  const errors = inspectBodyControl(phase);
  if (errors.length) throw new Error(errors.join('; '));
  return phase;
}

/** Inspect imported contracts without throwing. Supplying targets additionally
 * checks that a declared driver has authored intent. Held/derived/contact roles
 * are deliberately not added to the direct target count. */
export function inspectBodyControl(
  phase: BodyControlPhase,
  targets?: readonly { joint: string }[],
): string[] {
  const errors: string[] = [];
  const targetKeys = targets && new Set(targets.map(t => t.joint));
  for (const key of MAJOR_BODY_JOINTS) {
    const control = phase.joints[key];
    if (!control) { errors.push(`Missing control role: ${key}`); continue; }
    if (!control.purpose.trim()) errors.push(`Missing control purpose: ${key}`);
    if (!['driven', 'derived', 'held', 'contact', 'free'].includes(control.role)) {
      errors.push(`Unknown control role: ${key}`);
    }
    if (control.role === 'driven' && targetKeys && !targetKeys.has(key)) {
      errors.push(`Driver has no authored target: ${key}`);
    }
    if (control.role === 'derived' && (!control.source || control.source === key || !phase.joints[control.source])) {
      errors.push(`Invalid controller source: ${key}`);
    }
    if (control.role === 'contact' && (!control.support || !phase.supports.includes(control.support))) {
      errors.push(`Undeclared support: ${key}`);
    }
  }
  for (const key of Object.keys(phase.joints)) {
    if (!(MAJOR_BODY_JOINTS as readonly string[]).includes(key)) errors.push(`Unknown body joint: ${key}`);
  }
  return errors;
}
