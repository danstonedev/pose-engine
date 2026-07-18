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
  /** OPTIONAL intra-phase LEAD: the fraction (0..1] of this phase's travel at
   *  which this joint reaches its peak and holds. Default 1 (arrive at the phase
   *  boundary, lockstep). A value < 1 makes the joint LEAD its phase-mates — e.g.
   *  the ankle dorsiflexes to ~0.87 while the knee/hip complete at ~0.99 in a
   *  squat descent. Realized by `expandPeakTiming` (run inside
   *  resolveComposedMotion) as ordered sub-keyframes; the settled peak is
   *  unchanged, so ROM validation and goniometric measurement are untouched. */
  peakAt?: number;
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
  /** Cycle the phases until stopped (locomotion / repetitive movements). The
   *  LAST phase must flow back into the FIRST — the loop seam is a real
   *  transition the stage tweens through. Default false (one-shot). */
  loop?: boolean;
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
      'Hip and knee flex together (~1:1.2 to a deep/parallel bottom), the ankle dorsiflexes to advance the shin, and the trunk leans forward ~25° to keep the centre of mass over the mid-foot. Bilateral, planted. Sequencing: peak ankle dorsiflexion and pelvic tilt occur slightly EARLIER in the descent (~86-90%) than peak knee/hip/lumbar flexion (~98-99%, at the bottom) [Kim 2020]. Note: a true deep squat demands ~30° weight-bearing dorsiflexion; the engine caps active ankle DF at 20° (a standing-AROM norm), so 20° is the binding constraint here, not the biological target.',
    stance: 'planted',
    phases: [
      {
        name: 'descent-to-bottom',
        durationMs: 1000,
        holdMs: 350,
        // INTRA-PHASE LEAD (Kim 2020: ankle ~86-90% vs knee/hip ~98-99% of the
        // descent): the ankle dorsiflexion peaks EARLIER (~80%) — the shin
        // advances over the foot to carry the COM forward — while the knee/hip/
        // trunk complete at the bottom. Without this the descent is lockstep and
        // reads robotic over its 1 s travel. A single lead keeps the sub-phase gap
        // (~200 ms) above the velocity floor so phase timing stays exact.
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 100 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 100 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 120 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 120 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 20, peakAt: 0.8 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 20, peakAt: 0.8 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 27 },
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
        // INTRA-PHASE LEAD: a hip-dominant hinge initiates at the HIPS — the hips
        // (and the soft knee unlock) lead (~80%) while the lumbar then thoracic
        // spine round to reach for the floor at the end of range. Realizes the
        // "hinge first, then round the spine" sequence the coordination note
        // describes, instead of hip and spine folding in lockstep. The ~240 ms
        // sub-phase gap stays above the velocity floor so phase timing is exact.
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 70, peakAt: 0.8 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 70, peakAt: 0.8 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 40 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 20 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 12, peakAt: 0.8 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 12, peakAt: 0.8 },
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
      'Humerothoracic (goniometric) forward elevation to ~120° functional — this matches the mean forward elevation used across activities of daily living [Namdari 2012: 121°]; full physiologic range is ~160-170° (AAOS ideal 180°). Scapulohumeral rhythm averages ~2:1 (glenohumeral : scapular upward rotation) BEYOND the first ~30° "setting phase" (in which motion is predominantly glenohumeral and the scapula stabilises); the ratio varies with elevation and load [Inman 1944; Neumann; McQuade & Smidt 1998]. At the full 180° arc this yields ~120° GH + ~60° scapular; at this 120° functional target, ~85° GH + ~35° scapular upward rotation. Do NOT command the scapula separately — the humerothoracic readout already includes it. Shown on the right; mirror for the left or do both.',
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
      'Humerothoracic (goniometric) lateral elevation to ~120° functional — near the mean abduction used across activities of daily living [Namdari 2012: 128°]; full physiologic range is ~160-170° (AAOS ideal 180°). Same scapulohumeral rhythm ~2:1 BEYOND the first ~30° setting phase (predominantly glenohumeral early), varying with elevation and load; at this 120° target ~85° GH + ~35° scapular upward rotation. Do NOT command the scapula separately; the humerothoracic readout already includes it. Shown on the right.',
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
      'Reciprocal open-chain stepping, deliberately exaggerated vs normal gait (normal swing peaks ~30° hip / ~60° knee; arm swing ~20-25°): one hip and knee flex to lift the leg while the CONTRALATERAL arm swings forward (~38° — the amplified march arm), then the sides alternate — the cross-body coordination of gait, without travel.',
    stance: 'floating',
    phases: [
      {
        name: 'right-knee-up',
        durationMs: 550,
        holdMs: 120,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 60 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 80 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 38 },
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
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 80 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 38 },
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
    id: 'walk',
    label: 'Walk (gait cycle, in place)',
    aliases: ['walk', 'walking', 'gait', 'ambulate', 'stroll'],
    coordination:
      'One full gait cycle authored as 8 phases (both steps), looping. Sagittal peaks per normal free gait [Perry & Burnfield; Neumann]: hip 30° flexion at initial contact → −10° extension at terminal stance; knee ~5° at contact, ~18° loading-response shock absorption, ~40° at pre-swing, ~60° peak in initial swing; ankle rockers — plantarflexion to foot-flat after contact (−8°), dorsiflexion to 10° as the tibia advances over the stance foot, push-off plantarflexion −15° at pre-swing. Reciprocal arm swing ~±20° shoulder flexion, each arm peaking WITH the contralateral leg. Presented IN PLACE (treadmill convention — no root travel) so the looping cycle stays on stage; the pre-swing knee flexion + push-off happens across the loop seam (last phase flows back into the first). Planted.',
    stance: 'planted',
    loop: true,
    phases: [
      {
        name: 'right-initial-contact',
        durationMs: 200,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 40 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: -15 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 20 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: -20 },
        ],
      },
      {
        name: 'right-loading-response',
        durationMs: 200,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 25 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 18 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -8 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 5 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 60 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: -5 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 12 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: -12 },
        ],
      },
      {
        name: 'right-mid-stance',
        durationMs: 200,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 5 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 8 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 5 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 20 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 45 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
        ],
      },
      {
        name: 'right-terminal-stance',
        durationMs: 200,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 10 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: -20 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 20 },
        ],
      },
      {
        name: 'left-initial-contact',
        durationMs: 200,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 40 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -15 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 20 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: -20 },
        ],
      },
      {
        name: 'left-loading-response',
        durationMs: 200,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 25 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 18 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: -8 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 5 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 60 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -5 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 12 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: -12 },
        ],
      },
      {
        name: 'left-mid-stance',
        durationMs: 200,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 5 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 8 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 5 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 20 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 45 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
        ],
      },
      {
        name: 'left-terminal-stance',
        durationMs: 200,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 10 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: -20 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 20 },
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
      'The defining feature is the forward trunk/hip lean ("nose over toes") that brings the centre of mass over the feet BEFORE the hips and knees extend to rise — flexion momentum first, then extension [Schenkman 1990: flexion-momentum → momentum-transfer → extension]. The lean is HIP-DRIVEN with a relatively PRESERVED lumbar lordosis (only slight lumbar flexion) — heavy lumbar flexion is a compensatory/faulty pattern, not the healthy norm. Bilateral, planted. (No chair prop; the seated depth is the hip/knee flexion hold.)',
    stance: 'planted',
    phases: [
      {
        name: 'seated',
        durationMs: 700,
        holdMs: 300,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 85 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 85 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 95 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 95 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 12 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 12 },
        ],
      },
      {
        name: 'lean-forward',
        durationMs: 500,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 105 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 105 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 95 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 95 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 18 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 18 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 12 },
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
      'Split stance: the LEAD hip and knee flex (~75°/90° at a 90°-knee bottom) while the TRAIL knee flexes ~90° with its hip near-neutral/slightly extended, and the trunk stays close to vertical. Shown with the right leg leading. Planted.',
    stance: 'planted',
    phases: [
      {
        name: 'descend',
        durationMs: 900,
        holdMs: 300,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 75 },
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
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: -10 },
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
      ...(x.peakAt != null ? { peakAt: x.peakAt } : {}),
    })),
    durationMs: p.durationMs,
    ...(p.holdMs ? { holdMs: p.holdMs } : {}),
    ...(p.stance ? { stance: p.stance } : {}),
  }));
  return {
    name: t.id,
    startFrom: 'neutral',
    stance: t.stance,
    ...(t.loop ? { loop: true } : {}),
    keyframes,
  };
}

/**
 * Build a FORWARD-TRAVELING gait from the authored walk cycle — the movement
 * that makes closed-chain foot contact visible. Where the `walk` template is an
 * in-place looping cycle (the loop can't accumulate root travel — it would
 * teleport at the seam), THIS is a one-shot walk that advances the body +Z over
 * one stride (two steps) with the SAME 8-phase kinematics, and declares
 * ALTERNATING stance-foot contacts so each foot stays world-planted while the
 * body passes over it (the leg extends behind), instead of moonwalking.
 *
 * Reuses the walk phases verbatim (ROM-validated, coordination-gated) and adds:
 *  • cumulative `travel` forward per keyframe (one stride over the cycle);
 *  • `contacts`: the RIGHT foot is stance for the first half (right initial-
 *    contact → terminal-stance), the LEFT foot for the second half.
 * Non-looping and `startFrom:'current'`, so repeating it walks further from
 * wherever the body already is. Fixed cadence (timeScale 1) so the contact
 * windows — authored in phase time — line up with playback.
 */
export function buildTravelWalk(opts: { stepLengthM?: number } = {}): ComposedMotion {
  const walk = MOVEMENT_TEMPLATES.find((t) => t.id === 'walk');
  if (!walk) throw new Error('walk template missing');
  const base = templateToComposedMotion(walk); // 8 phases, planted, looping
  const n = base.keyframes.length;
  const strideM = (opts.stepLengthM ?? 0.35) * 2; // two steps advance one stride
  // Phase-boundary times (authored ms) and the right→left stance handoff.
  let cursor = 0;
  const boundaryMs = base.keyframes.map((kf) => (cursor += kf.durationMs));
  const totalMs = cursor;
  const halfMs = boundaryMs[Math.floor(n / 2) - 1] ?? totalMs / 2;
  const keyframes: SequenceKeyframe[] = base.keyframes.map((kf, i) => ({
    ...kf,
    travel: { direction: 'forward', meters: (strideM * (i + 1)) / n },
  }));
  return {
    name: 'walk-forward',
    startFrom: 'current',
    stance: 'planted',
    keyframes,
    contacts: [
      { foot: 'R_Foot', fromMs: 0, toMs: halfMs }, // right stance (phases 1–4)
      { foot: 'L_Foot', fromMs: halfMs, toMs: totalMs }, // left stance (phases 5–8)
    ],
  };
}

/**
 * Build a real COUNTERMOVEMENT VERTICAL JUMP — the physics the old "jump"
 * lacked (it was a quick squat that rose and never landed). Full ballistic
 * sequence with a genuine airborne peak and a landing absorption:
 *   1. LOAD — countermovement dip (hip/knee flex, ankle dorsiflex, arms swing
 *      back), COM drops. Planted.
 *   2. PROPULSION — explosive triple extension (hip/knee to 0, ankle
 *      plantarflexes into a toe push-off) + arms drive UP. Ballistic, planted
 *      (feet still driving the ground).
 *   3. APEX — the body leaves the floor: root travels UP to the peak with a
 *      brief hang time, legs tuck for clearance. FLOATING (no floor pin — the
 *      whole body, feet included, rises). Ballistic.
 *   4. DESCENT — the fall: root comes back down, legs extend to reach for the
 *      ground. Floating.
 *   5. LANDING — feet contact and ABSORB (hip/knee/ankle flex to cushion), COM
 *      dips. Planted (the pin re-grounds the feet).
 *   6. RECOVERY — extend back to a quiet stand. Planted.
 * Non-looping, `startFrom:'neutral'` (jump from standing). `heightM` sets the
 * apex COM rise (ROM-clamped joints, honest vertical via root translate).
 */
export function buildJump(opts: { heightM?: number } = {}): ComposedMotion {
  const apexM = Math.max(0.1, Math.min(0.7, opts.heightM ?? 0.4));
  const legs = (hip: number, knee: number, ankle: number) => [
    { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: hip },
    { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: hip },
    { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: knee },
    { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: knee },
    { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: ankle },
    { joint: 'R_Foot', motion: 'ankleFlexion', targetDegrees: ankle },
  ];
  const arms = (sh: number) => [
    { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: sh },
    { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: sh },
  ];
  const trunk = (deg: number) => [{ joint: 'Spine_Lower', motion: 'flexion', targetDegrees: deg }];
  return {
    name: 'vertical jump',
    startFrom: 'neutral',
    stance: 'planted',
    keyframes: [
      // 1. LOAD — countermovement dip.
      {
        durationMs: 380,
        holdMs: 90,
        stance: 'planted',
        targets: [...legs(40, 60, 15), ...arms(-25), ...trunk(15)],
      },
      // 2. PROPULSION — explosive triple extension + arm drive; toe push-off.
      {
        durationMs: 160,
        velocityClass: 'ballistic',
        stance: 'planted',
        targets: [...legs(0, 0, -25), ...arms(150), ...trunk(0)],
      },
      // 3. APEX — airborne peak with hang time; legs tuck for clearance.
      {
        durationMs: 260,
        holdMs: 110,
        velocityClass: 'ballistic',
        stance: 'floating',
        travel: { direction: 'up', meters: apexM },
        targets: [...legs(5, 25, 0), ...arms(150)],
      },
      // 4. DESCENT — the fall; legs extend to reach for the ground.
      {
        durationMs: 200,
        velocityClass: 'ballistic',
        stance: 'floating',
        travel: { direction: 'up', meters: 0.03 },
        targets: [...legs(0, 12, -5), ...arms(45)],
      },
      // 5. LANDING — feet contact and absorb (soft, flexed).
      {
        durationMs: 240,
        holdMs: 80,
        velocityClass: 'functional',
        stance: 'planted',
        travel: { direction: 'up', meters: 0 },
        targets: [...legs(45, 65, 15), ...arms(20), ...trunk(10)],
      },
      // 6. RECOVERY — quiet stand.
      {
        durationMs: 340,
        stance: 'planted',
        targets: [...legs(0, 0, 0), ...arms(0), ...trunk(0)],
      },
    ],
  };
}

/**
 * Adjust a gait's VERTICAL BOUNCE — the "spring vs glide" quality. Some people
 * bounce (a springy, high-knee, vaulting gait with a large pelvis rise-and-fall
 * per step); others glide (a smooth, low-knee, level-pelvis walk). The pelvis
 * vertical excursion is driven — through the closed-chain floor contact — by how
 * much the knees flex and lift through the cycle, so this scales knee flexion by
 * `amount` (0 = glide / smooth & low, 1 = the authored normal, 2 = a pronounced
 * bounce): a glider's shorter, lower knee lift keeps the pelvis level; a
 * bouncer's springy high knee lift vaults it. Hip/ankle and the reciprocal arm
 * swing are untouched (stride and cadence are `paceGait`'s job, kept orthogonal).
 * ROM-clamped on resolve. Pure.
 *
 * NOTE: the current engine grounds the walk with a vertical floor-pin (not the
 * gait "determinants" — pelvic tilt/rotation, controlled stance-knee wave), so
 * this is a believable qualitative knob rather than a calibrated centimetre
 * target; a determinant model is the follow-on for clinical-grade COM excursion.
 */
export function gaitBounce(motion: ComposedMotion, amount: number): ComposedMotion {
  const a = Math.max(0, Math.min(2, Number.isFinite(amount) ? amount : 1));
  if (a === 1) return motion;
  const kneeScale = 0.7 + 0.3 * a; // a=0 → 0.70 (glide), 1 → 1.0, 2 → 1.30 (bounce)
  return {
    ...motion,
    keyframes: motion.keyframes.map((kf) => ({
      ...kf,
      ...(kf.targets
        ? {
            targets: kf.targets.map((t) =>
              t.motion === 'kneeFlexion' ? { ...t, targetDegrees: t.targetDegrees * kneeScale } : t,
            ),
          }
        : {}),
    })),
  };
}

/** Sagittal joints whose EXCURSION defines stride length — scaled by pace. The
 *  reciprocal arm swing scales with the legs (arm swing grows with gait speed). */
const GAIT_STRIDE_MOTIONS = new Set(['hipFlexion', 'kneeFlexion', 'ankleFlexion', 'shoulderFlexion']);

/**
 * Couple a gait motion's STRIDE and CADENCE to a target walking speed.
 *
 * Real walking speed = stride length × cadence: a faster walk takes longer AND
 * quicker steps, not the same step played faster (which is all a bare `timeScale`
 * did — the Finding 6 gap). This splits the requested `speed` evenly between the
 * two (each ∝ √speed, so stride × cadence = speed exactly): the sagittal leg
 * angles and reciprocal arm swing are scaled by √speed (longer stride), and
 * `modifiers.timeScale` is set to √speed (quicker cadence). Over-range targets
 * are clamped by the normal ROM path on resolve. Pure; returns a new motion.
 * Speed 1 is (near-)identity. Intended for the looping gait template; a movement
 * without a stride (squat, reach) should just use `timeScale`.
 */
export function paceGait(motion: ComposedMotion, speed: number): ComposedMotion {
  const s = Math.min(1.5, Math.max(0.4, Number.isFinite(speed) ? speed : 1));
  const f = Math.sqrt(s); // even stride/cadence split so stride × cadence = speed
  const keyframes = motion.keyframes.map((kf) => ({
    ...kf,
    ...(kf.targets
      ? {
          targets: kf.targets.map((t) =>
            GAIT_STRIDE_MOTIONS.has(t.motion) ? { ...t, targetDegrees: t.targetDegrees * f } : t,
          ),
        }
      : {}),
  }));
  return { ...motion, keyframes, modifiers: { ...motion.modifiers, timeScale: f } };
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
    lines.push(
      `• ${t.label} [${t.stance}${t.loop ? ', loops' : ''}] — ${t.coordination} PHASES: ${phases}`,
    );
  }
  return lines.join('\n');
}
