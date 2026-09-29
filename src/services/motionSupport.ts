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
