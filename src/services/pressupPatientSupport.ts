import { getEffectiveRomRange, type RomScenarioConstraints } from './romConstraints';

/** Existing authored endpoint band; this is neither a new joint limit nor a
 * relaxation of contact or clinical acceptance. */
export const PRESSUP_ENDPOINT_FLEXION = Object.freeze({ min: -.05, max: 12 });

/** A prepared full press-up cannot attain its endpoint when the patient's
 * available elbow band excludes it. Refuse that known unsupported request
 * before posing; partial generic reaches retain their existing behavior.
 * Passing this check does not establish geometric or physical feasibility. */
export function pressupPatientRangeRefusal(
  motion: { pronePalmAnchorFit?: boolean; proneSkinSupport?: boolean; constraints?: RomScenarioConstraints | null },
  constraints?: RomScenarioConstraints | null,
): string | undefined {
  if (!motion.pronePalmAnchorFit || !motion.proneSkinSupport) return undefined;
  for (const side of ['L', 'R'] as const) {
    const range = getEffectiveRomRange(constraints ?? motion.constraints, `${side}_Forearm`, 'elbowFlexion');
    if (range && (range.min > PRESSUP_ENDPOINT_FLEXION.max || range.max < PRESSUP_ENDPOINT_FLEXION.min)) {
      return `${side === 'L' ? 'Left' : 'Right'} elbow limits (${range.min}–${range.max}°) do not allow the extension required for this press-up.`;
    }
  }
  return undefined;
}
