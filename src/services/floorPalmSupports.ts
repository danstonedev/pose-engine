import type { StanceContact } from './motionSequence';

/** Normalized from the bilateral Blender authoring controls in
 * floor-support-authoring-1/floor-support.blend (male upper arm 0.290506 m),
 * with the press-up anchors advanced 4 cm in floor-support-authoring-2
 * and upward elbow guides authored in floor-support-authoring-3. Project 5
 * tucks the trunk-push-up guides inward by 4 cm.
 * Press-up proposal8 retains the initial forward seed, shortens its elbow
 * guides, and fits one fixed palm layout from whole-chain reach geometry.
 * The other rigs use their own segment length. These specify a support layout;
 * every frame still solves against the patient's clinical bounds. */
export function floorPalmSupports(kind: 'push-up' | 'trunk-push-up' | 'press-up' | 'rock-back', fromMs: number): StanceContact[] {
  const forward = kind === 'rock-back' ? .481918 : kind === 'trunk-push-up' ? .550764 : kind === 'press-up' ? .258171 : .120480;
  return ['L', 'R'].map(side => ({
    foot: `${side}_Hand`, fromMs, holdOrientation: 'palm-down',
    palmSupport: { outward: .223748, forward, elbowOutward: kind === 'press-up' ? .35 : kind === 'trunk-push-up' ? .413073 : .550764, elbowBackward: kind === 'press-up' ? 1 : 1.376910, elbowUpward: kind === 'press-up' ? .5 : 1.376910,
      ...(kind === 'press-up' ? { surface: 'skin' as const } : {}) },
  }));
}
