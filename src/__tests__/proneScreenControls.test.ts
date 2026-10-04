import { expect, it, vi } from 'vitest';
import { composeScreenMotion, positionFor } from '../services/movementScreen';
import { resolveComposedMotion } from '../services/motionSequence';

vi.mock('../services/assessmentBodyMotions', async importOriginal => {
  const original = await importOriginal<typeof import('../services/assessmentBodyMotions')>();
  const source = original.BODY_ASSESSMENT_MOTIONS['extension-clearing']!;
  return { ...original, BODY_ASSESSMENT_MOTIONS: { ...original.BODY_ASSESSMENT_MOTIONS,
    'extension-clearing': (...args: Parameters<typeof source>) => ({
      ...source(...args), proneSkinSupport: true, pronePalmAnchorFit: true,
    }),
  } };
});

it('keeps Screen Hold position playable when the shared press-up opts into fixed palm planning', () => {
  const motion = composeScreenMotion(positionFor('extension-clearing'), 'R', null, 'extension-clearing', 'hold')!;
  expect(motion.pronePalmAnchorFit).toBe(true);
  expect(motion.keyframes).toHaveLength(2);
  expect(motion.keyframes.at(-1)!.holdMs).toBe(10000);
  const resolved = resolveComposedMotion(motion);
  expect(resolved.status, resolved.reason).toBe('ok');
  expect(resolved.pronePalmAnchorFit).toBe(true);
});
