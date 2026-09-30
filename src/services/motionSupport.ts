/** Whether contact authoring declares one unchanged, bilateral foot base for
 * the whole motion. This says nothing about achieved contact quality. Shared
 * by balance eligibility and weighted lowering; alternating gait is excluded. */
export function hasFixedBilateralFootSupport(motion: {
  contacts?: readonly unknown[];
  keyframes: readonly { durationMs?: number; holdMs?: number }[];
}): boolean {
  if (motion.contacts?.length !== 2 || !motion.keyframes.length) return false;
  const duration = motion.keyframes.reduce((sum, kf) =>
    typeof kf.durationMs === 'number' && Number.isFinite(kf.durationMs)
      ? sum + kf.durationMs + (kf.holdMs ?? 0) : Infinity, 0);
  const feet = new Set<string>();
  for (const raw of motion.contacts) {
    if (typeof raw !== 'object' || raw === null) return false;
    const contact = raw as { foot?: unknown; fromMs?: unknown; toMs?: unknown };
    if (contact.foot !== 'L_Foot' && contact.foot !== 'R_Foot') return false;
    if (contact.fromMs != null && !(typeof contact.fromMs === 'number' && contact.fromMs <= 0)) return false;
    if (contact.toMs != null && !(typeof contact.toMs === 'number' && contact.toMs >= duration)) return false;
    feet.add(contact.foot);
  }
  return feet.size === 2;
}

/** A bilateral base established at the end of an explicit first setup phase.
 * Subsequent stepping/releasing contacts are excluded. Unlike whole-motion
 * support this must not plant the feet during the stance-width setup itself.
 */
export function bilateralFootSetupMs(motion: {
  footSupportSetup?: boolean;
  contacts?: readonly { foot: string; fromMs?: number; toMs?: number }[];
  keyframes: readonly { durationMs?: number; holdMs?: number }[];
}): number | null {
  if (!motion.footSupportSetup) return null;
  const [a, b] = motion.contacts ?? [];
  const first = motion.keyframes[0];
  if (motion.contacts?.length !== 2 || !a || !b || !first) return null;
  if (new Set([a.foot, b.foot]).size !== 2 || ![a.foot, b.foot].every(f => f === 'L_Foot' || f === 'R_Foot')) return null;
  const at = a.fromMs;
  return at != null && Number.isFinite(at) && at > 0 && at === b.fromMs
    && a.toMs == null && b.toMs == null
    && at === (first.durationMs ?? 0) + (first.holdMs ?? 0) ? at : null;
}
