/**
 * CLINICIAN-AUTHORED MOVEMENT TEMPLATES — reference material for the *content*
 * of core clinical movements.
 *
 * WHY. The composer's ROM limits are sourced (AAOS / Norkin & White) and every
 * frame is measured, but the SHAPE of a movement — which joints participate, to
 * what peak angles, in what timing and coordination — was previously left to the
 * language model's own knowledge. These templates encode that shape explicitly,
 * as a small library of the core movements, so the model has an authored anchor
 * to fill the blanks around instead of guessing from scratch.
 *
 * Each template captures the three things that make a movement recognizable:
 *   • PEAK ANGLES     — the magnitude each joint reaches (per phase).
 *   • TIMING          — phase durations + which phases hold (the tempo).
 *   • COORDINATION    — which joints move together and in what ratio.
 *
 * Two uses, from ONE source of truth:
 *   1. {@link describeMovementTemplates} renders the library into the compose
 *      tool's prompt, so the planner anchors on real coordination.
 *   2. {@link templateToComposedMotion} turns a template into a playable,
 *      measurable ComposedMotion — which lets the test-suite RESOLVE each
 *      template through the real ROM path (proving every peak is within
 *      normative range) and SAMPLE it on the rig (proving the authored
 *      coordination is achievable and measures back to the authored peaks).
 *
 * These values are clinician-authored from standard kinesiology (e.g. Neumann,
 * *Kinesiology of the Musculoskeletal System*; scapulohumeral rhythm ~2:1) and
 * are flagged for SME verification, exactly like the ROM registry — they are a
 * reviewed reference, not mocap.
 */

import type { ComposedMotion, SequenceKeyframe, StanceMode } from './motionSequence';

/** One joint's peak angle within a phase (absolute clinical degrees). */
export interface TemplateTarget {
  joint: string;
  motion: string;
  peakDeg: number;
}

/** One timed phase of a movement: the joint peaks reached by its end, how long
 *  the travel into it takes, and how long it dwells there. */
export interface TemplatePhase {
  name: string;
  durationMs: number;
  holdMs?: number;
  stance?: StanceMode;
  targets: TemplateTarget[];
}

export interface MovementTemplate {
  id: string;
  label: string;
  /** Instruction keywords that select this template (lowercased substrings). */
  aliases: string[];
  /** One-line clinician note on the coordination the template teaches. */
  coordination: string;
  stance: StanceMode;
  phases: TemplatePhase[];
  source: string;
}

const VERIFY = 'clinician-authored from standard kinesiology; verify with SME';

export const MOVEMENT_TEMPLATES: MovementTemplate[] = [
  {
    id: 'squat',
    label: 'Bodyweight squat',
    aliases: ['squat', 'deep squat', 'bodyweight squat', 'sit back'],
    coordination:
      'Hip and knee flex together (~1:1.1), the ankle dorsiflexes to keep the shin advancing, and the trunk leans forward ~20° so the centre of mass stays over the mid-foot. Bilateral, weight-bearing (planted).',
    stance: 'planted',
    phases: [
      {
        name: 'descent-to-bottom',
        durationMs: 1000,
        holdMs: 350,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 100 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 100 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 115 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 115 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 18 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 18 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 20 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 10 },
        ],
      },
      {
        name: 'ascent-to-stand',
        durationMs: 1000,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'forward-hip-hinge',
    label: 'Forward hip-hinge / toe-touch',
    aliases: ['toe touch', 'touch your toes', 'forward bend', 'hip hinge', 'bend forward', 'reach for the floor'],
    coordination:
      'A hip-dominant hinge: most of the excursion is hip flexion, with the lumbar then thoracic spine flexing to round the reach, and the knees only softly unlocking. Planted.',
    stance: 'planted',
    phases: [
      {
        name: 'bend-down',
        durationMs: 1200,
        holdMs: 350,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 70 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 70 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 40 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 20 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 12 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 12 },
        ],
      },
      {
        name: 'return-upright',
        durationMs: 1200,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'shoulder-flexion-elevation',
    label: 'Shoulder flexion (forward elevation)',
    aliases: ['raise your arm', 'reach overhead', 'shoulder flexion', 'lift your arm forward', 'arm overhead', 'forward elevation'],
    coordination:
      'Humerothoracic (goniometric) forward elevation to ~120° functional; full physiologic range is ~160-170°. Underlying scapulohumeral rhythm ~2:1 — of that elevation roughly 2/3 is glenohumeral and 1/3 scapular upward rotation (do not command the scapula separately; the humerothoracic readout already includes it). Shown on the right; mirror for the left or do both.',
    stance: 'floating',
    phases: [
      {
        name: 'elevate',
        durationMs: 1200,
        holdMs: 300,
        targets: [{ joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 120 }],
      },
      {
        name: 'lower',
        durationMs: 1200,
        targets: [{ joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 }],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'shoulder-abduction-elevation',
    label: 'Shoulder abduction (lateral elevation)',
    aliases: ['abduct', 'lateral raise', 'raise your arm out to the side', 'shoulder abduction', 'arm out to the side'],
    coordination:
      'Humerothoracic (goniometric) lateral elevation to ~120° functional; full physiologic range is ~160-170°. Same underlying scapulohumeral rhythm ~2:1 (≈2/3 glenohumeral, 1/3 scapular upward rotation) — do not command the scapula separately; the humerothoracic readout already includes it. Shown on the right.',
    stance: 'floating',
    phases: [
      {
        name: 'abduct',
        durationMs: 1200,
        holdMs: 300,
        targets: [{ joint: 'R_UpperArm', motion: 'shoulderAbduction', peakDeg: 120 }],
      },
      {
        name: 'lower',
        durationMs: 1200,
        targets: [{ joint: 'R_UpperArm', motion: 'shoulderAbduction', peakDeg: 0 }],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'high-knee-march',
    label: 'High-knee march (reciprocal, in place)',
    aliases: ['march', 'high knee', 'marching', 'step in place', 'lift your knees'],
    coordination:
      'Reciprocal open-chain stepping: one hip and knee flex to lift the leg while the CONTRALATERAL arm swings forward (~25° shoulder flexion), then the sides alternate — the cross-body coordination of gait, without travel.',
    stance: 'floating',
    phases: [
      {
        name: 'right-knee-up',
        durationMs: 550,
        holdMs: 120,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 60 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 70 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 25 },
        ],
      },
      {
        name: 'lower-right',
        durationMs: 450,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
        ],
      },
      {
        name: 'left-knee-up',
        durationMs: 550,
        holdMs: 120,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 60 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 70 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 25 },
        ],
      },
      {
        name: 'lower-left',
        durationMs: 450,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'sit-to-stand',
    label: 'Sit-to-stand',
    aliases: ['sit to stand', 'stand up from a chair', 'sit-to-stand', 'rise from sitting', 'get up from the chair'],
    coordination:
      'The defining feature is the forward trunk/hip lean ("nose over toes") that brings the centre of mass over the feet BEFORE the hips and knees extend to rise — flexion momentum first, then extension. Bilateral, planted. (No chair prop; the seated depth is the hip/knee flexion hold.)',
    stance: 'planted',
    phases: [
      {
        name: 'seated',
        durationMs: 700,
        holdMs: 300,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 85 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 85 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 90 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 90 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 12 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 12 },
        ],
      },
      {
        name: 'lean-forward',
        durationMs: 500,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 100 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 100 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 90 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 90 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 18 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 18 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 25 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 10 },
        ],
      },
      {
        name: 'rise-to-stand',
        durationMs: 800,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'forward-lunge',
    label: 'Forward lunge / split squat',
    aliases: ['lunge', 'split squat', 'forward lunge', 'stationary lunge'],
    coordination:
      'Split stance: the LEAD hip and knee flex (~55°/90°) while the TRAIL knee flexes ~90° with its hip near-neutral/slightly extended, and the trunk stays close to vertical. Shown with the right leg leading. Planted.',
    stance: 'planted',
    phases: [
      {
        name: 'descend',
        durationMs: 900,
        holdMs: 300,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 55 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 90 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 90 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 8 },
        ],
      },
      {
        name: 'rise',
        durationMs: 900,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'single-leg-stance',
    label: 'Single-leg stance (balance)',
    aliases: ['single leg stance', 'stand on one leg', 'single-leg balance', 'balance on one foot', 'one-legged stance'],
    coordination:
      'Stand on the left leg and lift the right: the lifted hip flexes ~30° and its knee ~45°, while the trunk stays quiet and level over the stance foot. Long hold = the balance challenge. Planted (stance leg).',
    stance: 'planted',
    phases: [
      {
        name: 'lift-and-balance',
        durationMs: 700,
        holdMs: 1500,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 45 },
        ],
      },
      {
        name: 'lower',
        durationMs: 700,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'cervical-rotation',
    label: 'Cervical rotation (AROM screen)',
    aliases: ['turn your head', 'cervical rotation', 'rotate your neck', 'look left and right', 'neck rotation'],
    coordination:
      'Pure axial rotation of the neck — rotate fully to one side, return to centre, then the other, keeping flexion and side-bend near zero. AROM ~70° each way (normative ~80°).',
    stance: 'floating',
    phases: [
      {
        name: 'rotate-left',
        durationMs: 700,
        holdMs: 300,
        targets: [{ joint: 'Neck', motion: 'rotation', peakDeg: 70 }],
      },
      {
        name: 'centre-1',
        durationMs: 500,
        targets: [{ joint: 'Neck', motion: 'rotation', peakDeg: 0 }],
      },
      {
        name: 'rotate-right',
        durationMs: 700,
        holdMs: 300,
        targets: [{ joint: 'Neck', motion: 'rotation', peakDeg: -70 }],
      },
      {
        name: 'centre-2',
        durationMs: 500,
        targets: [{ joint: 'Neck', motion: 'rotation', peakDeg: 0 }],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'lumbar-flexion-extension',
    label: 'Lumbar flexion / extension (AROM screen)',
    aliases: ['bend your back', 'lumbar flexion', 'arch your back', 'lumbar extension', 'trunk flexion and extension', 'flex and extend your spine'],
    coordination:
      'Spine-dominant trunk AROM (distinct from the hip-hinge, which is hip-dominant): round forward into flexion through the lumbar then thoracic spine, return, then extend backward. Little hip motion.',
    stance: 'planted',
    phases: [
      {
        name: 'flex-forward',
        durationMs: 1000,
        holdMs: 300,
        targets: [
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 55 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 25 },
        ],
      },
      {
        name: 'return-1',
        durationMs: 800,
        targets: [
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 0 },
        ],
      },
      {
        name: 'extend-back',
        durationMs: 1000,
        holdMs: 300,
        targets: [
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: -20 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: -15 },
        ],
      },
      {
        name: 'return-2',
        durationMs: 800,
        targets: [
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
];

/** Turn a template into a playable, measurable ComposedMotion (starts from
 *  anatomic neutral). The engine then clamps + measures it like any motion. */
export function templateToComposedMotion(t: MovementTemplate): ComposedMotion {
  const keyframes: SequenceKeyframe[] = t.phases.map((p) => ({
    targets: p.targets.map((x) => ({
      joint: x.joint,
      motion: x.motion,
      targetDegrees: x.peakDeg,
    })),
    durationMs: p.durationMs,
    ...(p.holdMs ? { holdMs: p.holdMs } : {}),
    ...(p.stance ? { stance: p.stance } : {}),
  }));
  return { name: t.id, startFrom: 'neutral', stance: t.stance, keyframes };
}

/** Select the template whose aliases best match a free-text instruction, or null. */
export function findMovementTemplate(instruction: string): MovementTemplate | null {
  const text = instruction.toLowerCase();
  let best: MovementTemplate | null = null;
  let bestLen = 0;
  for (const t of MOVEMENT_TEMPLATES) {
    for (const a of t.aliases) {
      if (text.includes(a) && a.length > bestLen) {
        best = t;
        bestLen = a.length;
      }
    }
  }
  return best;
}

/** Render the whole library as a compact reference block for the planner prompt:
 *  each movement's phases (timing), peak angles, and coordination. */
export function describeMovementTemplates(): string {
  const lines: string[] = [];
  for (const t of MOVEMENT_TEMPLATES) {
    const phases = t.phases
      .map((p) => {
        const peaks = p.targets
          .map((x) => `${x.joint}.${x.motion} ${x.peakDeg}°`)
          .join(', ');
        const hold = p.holdMs ? ` hold ${p.holdMs}ms` : '';
        return `${p.name} (${p.durationMs}ms${hold}): ${peaks}`;
      })
      .join(' | ');
    lines.push(`• ${t.label} [${t.stance}] — ${t.coordination} PHASES: ${phases}`);
  }
  return lines.join('\n');
}
