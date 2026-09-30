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

/** A bilateral base established after explicit setup steps. Each foot's last
 * contact must continue through the squat; earlier windows may release as the
 * opposite foot takes weight. The last landing must match a keyframe boundary.
 */
export function bilateralFootSetupMs(motion: {
  footSupportSetup?: boolean;
  contacts?: readonly { foot: string; fromMs?: number; toMs?: number }[];
  keyframes: readonly { durationMs?: number; holdMs?: number }[];
}): number | null {
  if (!motion.footSupportSetup) return null;
  const contacts = motion.contacts ?? [];
  if (contacts.length < 2 || !motion.keyframes.length ||
    contacts.some(c => c.foot !== 'L_Foot' && c.foot !== 'R_Foot')) return null;
  const final = ['L_Foot', 'R_Foot'].map(foot => contacts.filter(c => c.foot === foot && c.toMs == null));
  if (final.some(list => list.length !== 1)) return null;
  const starts = final.map(list => list[0]!.fromMs);
  if (starts.some(t => t == null || !Number.isFinite(t) || t < 0)) return null;
  const at = Math.max(...starts as number[]);
  if (at <= 0 || contacts.some(c => c.toMs != null && (!Number.isFinite(c.toMs) || c.toMs > at))) return null;
  let elapsed = 0;
  for (const kf of motion.keyframes) {
    elapsed += (kf.durationMs ?? 0) + (kf.holdMs ?? 0);
    if (Math.abs(elapsed - at) < 1e-5) return at;
    if (elapsed > at) break;
  }
  return null;
}
