import { describe, expect, it } from 'vitest';
import { floorReferenceForSupport, groundingContactsFor, type FloorReference } from '../services/rootMotion';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';

describe('explicit movement support plane', () => {
  const captured: FloorReference = {
    floorY: .02, restY: { L_Foot: .075, R_Foot: .075, L_Toes: .02, R_Toes: .02 },
    pronePelvisPoint: [0, -.03, .12],
  };
  const motion: ComposedMotion = { keyframes: [{ durationMs: 1000,
    targets: [{ joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: 20 }] }] };

  it.each([0, -.1, .45])('preserves finite support plane %s through JSON and resolution', supportPlaneY => {
    const saved = JSON.parse(JSON.stringify({ ...motion, supportPlaneY }));
    const resolved = resolveComposedMotion(saved);
    expect(resolved.status).toBe('ok');
    expect(resolved.supportPlaneY).toBe(supportPlaneY);
  });

  it.each([undefined, NaN, Infinity, -Infinity, '0'])('does not resolve an invalid or absent plane %s', supportPlaneY => {
    const resolved = resolveComposedMotion({ ...motion, supportPlaneY } as ComposedMotion);
    expect(resolved.status).toBe('ok');
    expect(resolved).not.toHaveProperty('supportPlaneY');
    expect(floorReferenceForSupport(captured, supportPlaneY as number).floorY).toBe(captured.floorY);
  });

  it('keeps pelvis and reach contacts on one plane while retaining standing rest heights', () => {
    const floor = floorReferenceForSupport(captured, 0);
    expect(groundingContactsFor('prone-supported', floor)[0]).toEqual({
      bone: 'Hips', targetY: 0, mode: 'vertical', surface: null,
    });
    expect(groundingContactsFor('prone-supported', captured)[0]?.localPoint).toBe(captured.pronePelvisPoint);
    expect(groundingContactsFor('plank', floor).every(contact => contact.targetY === 0)).toBe(true);
    expect(floor.restY).toEqual(captured.restY);
    expect(captured.floorY).toBe(.02);
  });

  it('does not leak a plane or contact anchors into the following movement', () => {
    const first = floorReferenceForSupport(captured, 0);
    first.supportAnchorsXZ = { Hips: [.1, .3] };
    first.proneSupportPrepare = () => {};
    first.pronePelvisSurface = { meshes: [] };
    const following = floorReferenceForSupport(captured);
    expect(following.floorY).toBe(.02);
    expect(following.supportAnchorsXZ).toBeUndefined();
    expect(following.usePosedProneSupport).toBeUndefined();
    expect(captured.supportAnchorsXZ).toBeUndefined();
    expect(floorReferenceForSupport(first, .45).supportAnchorsXZ).toBeUndefined();
    expect(floorReferenceForSupport(first, .45).proneSupportPrepare).toBeUndefined();
    expect(floorReferenceForSupport(first, .45).pronePelvisSurface).toBeUndefined();
  });

  it('retains whole-chain support and patient bounds only for a prepared prone trajectory', () => {
    const authored = { ...BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), proneSkinSupport: true };
    const constraints = { L_Leg: { kneeFlexion: { availableRange: { min: 0, max: 5 } } } };
    const resolved = resolveComposedMotion(authored, undefined, { constraints });
    expect(resolved.status).toBe('ok');
    expect(resolved.proneSkinSupport).toBe(true);
    expect(resolved.constraints).toEqual(constraints);
    expect(resolved.constraints).not.toBe(constraints);
    for (const changed of [
      { ...authored, startAtSetup: false },
      { ...authored, supportPlaneY: undefined },
      { ...authored, keyframes: authored.keyframes.map((frame, index) => index ? frame : { ...frame, groundingPosture: 'standing' as const }) },
      { ...authored, keyframes: authored.keyframes.map(frame => ({ ...frame, stance: 'floating' as const })) },
    ]) expect(resolveComposedMotion(changed).reason).toBe('prone-skin-support-requires-prepared-planted-prone-plane');
  });

  it('requires declared bilateral skin contacts before planning fixed palms', () => {
    const authored = { ...BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), proneSkinSupport: true, pronePalmAnchorFit: true };
    expect(resolveComposedMotion(authored).pronePalmAnchorFit).toBe(true);
    for (const changed of [
      { ...authored, proneSkinSupport: false },
      { ...authored, contacts: authored.contacts?.slice(0, 1) },
      { ...authored, contacts: authored.contacts?.map(contact => ({ ...contact, holdOrientation: false as const })) },
      { ...authored, keyframes: authored.keyframes.slice(0, 1) },
      { ...authored, keyframes: [...authored.keyframes, authored.keyframes[0]] },
      { ...authored, loop: true },
      { ...authored, reps: 2 },
      { ...authored, modifiers: { timeScale: .5 } },
    ]) expect(resolveComposedMotion(changed).reason).toBe('prone-palm-fit-requires-setup-extension-with-optional-return-and-bilateral-skin-palms');
  });
});
