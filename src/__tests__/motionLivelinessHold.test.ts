/**
 * MOTION-TIME LIVELINESS THROUGH THE READY HOLD (stageMotionLiveliness.undo).
 *
 * The stage applies the realism breathing/micro-sway AFTER its recording tap and
 * relied on a driver rewriting the two trunk bones before the next one. Through
 * the ready hold nothing does: the composed motion is already active (so the
 * overlay runs) but the settle tween has finished and the trajectory has not
 * started. Each frame then premultiplied onto the last, and the tap recorded
 * the pile-up. Replayed below at 60 Hz (650 ms settle, 300 ms hold) on
 * 2d8f5e6's overlay, the trunk had drifted 11.8–17.9° from the held pose by the
 * end of the hold at liveliness 0.5 and 23.5–35.8° at 1 — in the frames the gait
 * check's 0.05° stillness search reads a recording's ready-settle head from.
 *
 * The stage loop now lifts the last frame's deltas straight after its driver
 * step (a bone a driver rewrote keeps the driver's pose), so the report and the
 * tap read the held pose and the overlay never stacks.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createMotionLiveliness } from '../services/stageMotionLiveliness';
import { createBreathState } from '../services/stageBreath';

const stageSource = readFileSync(fileURLToPath(new URL('../ExamStage3D.svelte', import.meta.url)), 'utf8');

const AP = new THREE.Vector3(1, 0, 0);
const ML = new THREE.Vector3(0, 0, 1);
const DT = 1 / 60;

function angleDeg(a: THREE.Quaternion, b: THREE.Quaternion): number {
  return (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;
}

function trunk() {
  const root = new THREE.Object3D();
  const lower = new THREE.Bone();
  const upper = new THREE.Bone();
  root.add(lower);
  lower.add(upper);
  // A held pose that is not the identity, so a restore to the wrong value shows.
  const heldLower = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, -0.05, 0.03));
  const heldUpper = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.08, 0.02, 0.06));
  lower.quaternion.copy(heldLower);
  upper.quaternion.copy(heldUpper);
  const bones = new Map<string, THREE.Bone>([
    ['Spine_Lower', lower],
    ['Spine_Upper', upper],
  ]);
  return { root, lower, upper, heldLower, heldUpper, bones };
}

describe('motion-time liveliness through a hold nothing drives', () => {
  for (const amount of [0.5, 1]) {
    for (const breathStart of [0, 1.5, 3, 4.5]) {
      it(`liveliness ${amount}, breath phase ${breathStart}: the tap reads the held pose and the trunk never stacks`, () => {
        const t = trunk();
        const breath = createBreathState();
        while (breath.phase < breathStart) breath.advancePhase(DT);
        const live = createMotionLiveliness();
        live.reset();
        // The settle tween: a driver writes the held pose every frame (the
        // lift keeps it), then the overlay goes on top.
        for (let s = 0; s < 0.65; s += DT) {
          t.lower.quaternion.copy(t.heldLower);
          t.upper.quaternion.copy(t.heldUpper);
          expect(live.undo(t.bones, t.root), 'a driven frame keeps its driver’s pose').toBe(false);
          expect(t.lower.quaternion.equals(t.heldLower)).toBe(true);
          live.apply(DT, amount, t.bones, t.root, breath, AP, ML);
        }
        // The hold: nothing writes the trunk. Lift → (report + tap read) → apply.
        let worstShown = 0;
        for (let h = 0; h < 0.3; h += DT) {
          live.undo(t.bones, t.root);
          expect(t.lower.quaternion.equals(t.heldLower), 'the tap reads the held low back').toBe(true);
          expect(t.upper.quaternion.equals(t.heldUpper), 'the tap reads the held thorax').toBe(true);
          live.apply(DT, amount, t.bones, t.root, breath, AP, ML);
          worstShown = Math.max(worstShown, angleDeg(t.lower.quaternion, t.heldLower), angleDeg(t.upper.quaternion, t.heldUpper));
        }
        // What shows is one frame's breathing/sway, never a pile of them: the
        // overlay's own peaks (thorax breath 2.2° × amount × its exertion scale,
        // low back 1.3° + 0.9° sway × amount) bound it.
        expect(worstShown).toBeLessThanOrEqual(2.2 * 1.5 * amount + 1e-9);
      });
    }
  }

  it('a driver that rewrote a bone keeps it; only a bone still as the overlay left it is restored', () => {
    const t = trunk();
    const breath = createBreathState();
    while (breath.phase < 1.2) breath.advancePhase(DT);
    const live = createMotionLiveliness();
    live.reset();
    for (let s = 0; s < 0.5; s += DT) live.apply(DT, 1, t.bones, t.root, breath, AP, ML);
    const driven = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0, 0));
    t.upper.quaternion.copy(driven); // the thorax is driven this frame, the low back is not
    const before = t.lower.quaternion.clone();
    live.apply(DT, 1, t.bones, t.root, breath, AP, ML);
    const drivenLive = t.upper.quaternion.clone();
    t.upper.quaternion.copy(driven.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.01, 0))));
    const rewritten = t.upper.quaternion.clone();
    expect(live.undo(t.bones, t.root)).toBe(true);
    expect(t.upper.quaternion.equals(rewritten), 'the rewritten thorax keeps the driver’s pose').toBe(true);
    expect(t.lower.quaternion.equals(before), 'the untouched low back gets its pre-apply pose back').toBe(true);
    expect(drivenLive.equals(driven)).toBe(false);
    // Nothing left to lift.
    expect(live.undo(t.bones, t.root)).toBe(false);
  });

  it('the stage lifts it straight after the driver step, before the streamed report and the recording tap', () => {
    expect(stageSource).toMatch(
      /if \(activeTrajectory\) stepTrajectory\(performance\.now\(\)\);[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if \(undoMotionLiveliness\(\)\) renderNeeded = true;\n(?:\s*\/\/[^\n]*\n)*\s*if \(\(mixer && activeMotionId\) \|\| composedActive\) \{[\s\S]*?measureNowFresh\(\)[\s\S]*?recordingTap\.sample\(performance\.now\(\), buildFrame\);[\s\S]{0,1500}applyMotionLiveliness\(motionDelta\)/,
    );
    expect(stageSource).toMatch(/function undoMotionLiveliness\(\): boolean \{\s*return motionLive\.undo\(motionCapBones, modelRoot\);/);
  });
});
