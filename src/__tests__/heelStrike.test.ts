/**
 * HEEL-STRIKE TRANSIENT GATE (wave 4.6) — footfalls carry an impact accent.
 *
 * The audit finding: the calibrated + smoothed gait vertical deliberately
 * rounds the double-support valley into a glide (do NOT reduce that
 * smoothing), so contact carried no weight. The fix is a small additive accent
 * ON TOP of the smoothed arc: at each foot-contact instant (the starts of the
 * SAME planned stance schedule the shuttle/travel derivations follow), a brief
 * (~110 ms) dip-and-recover on root Y shaped by a compact critically-damped
 * bump, amplitude scaled by the pre-contact descent rate of the smoothed arc
 * (services/rootMotion `deriveHeelStrikeAccents`). Gait-only; root-Y only.
 *
 * Rig gates (real male GLB, offline sampler = the stage's lockstep twin):
 *   • the walk's root-Y shows a measurable 0.3–1.2 cm dip within ~120 ms after
 *     EACH contact instant (vs an accent-suppressed control of the same walk);
 *   • outside the accent spans the two runs are BYTE-IDENTICAL — the accent
 *     touches nothing else (and non-gait motions carry no accent at all);
 *   • the smoothed-vertical quality gates still hold WITH the accent: p2p
 *     excursion < 10 cm and no >6 cm drop inside any 100 ms window;
 *   • the stance feet stay planted — slide budgets unchanged.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { measureContactSlide } from '../services/footContact';
import {
  applyHeelStrikeAccent,
  deriveHeelStrikeAccents,
  heelStrikeOffsetAt,
  HEEL_STRIKE_MAX_DIP_M,
  HEEL_STRIKE_MIN_DIP_M,
  HEEL_STRIKE_SPAN_MS,
} from '../services/rootMotion';
import {
  buildTravelWalk,
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

// ── Pure primitive gates (no rig) ────────────────────────────────────────────

describe('deriveHeelStrikeAccents / heelStrikeOffsetAt — the pure primitive', () => {
  const flatArc = () => 1;
  it('is the strict identity for a null schedule and outside every span', () => {
    expect(applyHeelStrikeAccent(1.23, null, 500)).toBe(1.23);
    expect(heelStrikeOffsetAt(null, 500)).toBe(0);
    const acc = deriveHeelStrikeAccents(flatArc, [1000], 4000)!;
    expect(acc).not.toBeNull();
    expect(heelStrikeOffsetAt(acc, 999)).toBe(0); // before contact
    expect(heelStrikeOffsetAt(acc, 1000)).toBe(0); // zero AT contact (C0 entry)
    expect(heelStrikeOffsetAt(acc, 1000 + HEEL_STRIKE_SPAN_MS)).toBe(0); // recovered
    expect(heelStrikeOffsetAt(acc, 3000)).toBe(0);
  });

  it('dips DOWN inside the span, peaking early (an impact, recovered within the span)', () => {
    const acc = deriveHeelStrikeAccents(flatArc, [1000], 4000)!;
    let minOff = 0;
    let minAt = 0;
    for (let t = 1000; t <= 1000 + HEEL_STRIKE_SPAN_MS; t += 1) {
      const off = heelStrikeOffsetAt(acc, t);
      expect(off).toBeLessThanOrEqual(0);
      if (off < minOff) {
        minOff = off;
        minAt = t - 1000;
      }
    }
    expect(minOff, 'a flat arrival still lands with the base dip').toBeCloseTo(-HEEL_STRIKE_MIN_DIP_M, 4);
    expect(minAt, 'the dip peaks in the first half of the span (impact, then recovery)')
      .toBeLessThan(HEEL_STRIKE_SPAN_MS / 2);
  });

  it('scales amplitude with the PRE-CONTACT descent rate — faster arrival, firmer accent', () => {
    // A steep smoothed descent into contact (≥ the reference rate) saturates the
    // dip at the cap; a flat arrival keeps the base dip.
    const steep = deriveHeelStrikeAccents((t) => -0.4 * (t / 1000), [1000], 4000)!;
    const flat = deriveHeelStrikeAccents(flatArc, [1000], 4000)!;
    expect(steep.accents[0]!.dipM).toBeCloseTo(HEEL_STRIKE_MAX_DIP_M, 6);
    expect(flat.accents[0]!.dipM).toBeCloseTo(HEEL_STRIKE_MIN_DIP_M, 6);
    expect(steep.accents[0]!.dipM).toBeGreaterThan(flat.accents[0]!.dipM);
    // A RISING arrival (no descent) clamps to the base dip too — never inverts.
    const rising = deriveHeelStrikeAccents((t) => 0.4 * (t / 1000), [1000], 4000)!;
    expect(rising.accents[0]!.dipM).toBeCloseTo(HEEL_STRIKE_MIN_DIP_M, 6);
  });

  it('skips the standing entry (t≈0) and returns null when nothing qualifies — deterministic otherwise', () => {
    expect(deriveHeelStrikeAccents(flatArc, [0], 4000)).toBeNull();
    expect(deriveHeelStrikeAccents(flatArc, [], 4000)).toBeNull();
    const a = deriveHeelStrikeAccents((t) => Math.sin(t / 300) * 0.02, [900, 1800], 4000);
    const b = deriveHeelStrikeAccents((t) => Math.sin(t / 300) * 0.02, [900, 1800], 4000);
    expect(a).not.toBeNull();
    expect(a!.accents.length).toBe(2);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ── Rig gates ────────────────────────────────────────────────────────────────

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let rootRest0: THREE.Vector3;
let rootQuat0: THREE.Quaternion;

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  rootRest0 = root.position.clone();
  rootQuat0 = root.quaternion.clone();
});

/** The sampler captures the current root as its rest, so reset to origin before
 *  each sample (else consecutive samples accumulate the prior travel). */
function resetHarness(): void {
  applyAnatomicPose(root, variantCfg);
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
}

function sample(motion: ComposedMotion, sampleHz = 120): MotionRecording {
  resetHarness();
  const resolved = resolveComposedMotion(motion, variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz,
  });
}

/** Contact instants of the travel walk (recording time base): the starts of
 *  its planned stance schedule, scaled authored→recording exactly as the
 *  sampler scales them, skipping the t=0 standing entry. */
function contactInstants(m: ComposedMotion, rec: MotionRecording): number[] {
  const authoredMs = m.keyframes.reduce((s, k) => s + (k.durationMs ?? 0) + (k.holdMs ?? 0), 0);
  const scale = rec.frames[rec.frames.length - 1]!.tMs / authoredMs;
  return (m.gaitStanceWindowsMs ?? [])
    .map((w) => w.fromMs * scale)
    .filter((t) => t > 1);
}

/** Horizontal slide of a foot over the longest contiguous lower-foot run —
 *  the honest stance-slide metric (mirrors gaitTravel.test.ts). */
function plantedSlideM(rec: MotionRecording, foot: 'R_Foot' | 'L_Foot'): number {
  const other = foot === 'R_Foot' ? 'L_Foot' : 'R_Foot';
  const low = rec.frames.map((f) => f.worldTracks![foot]![1] <= f.worldTracks![other]![1]);
  let bestStart = 0;
  let bestLen = 0;
  let curStart = -1;
  for (let i = 0; i <= rec.frames.length; i += 1) {
    if (i < rec.frames.length && low[i]) {
      if (curStart < 0) curStart = i;
    } else if (curStart >= 0) {
      if (i - curStart > bestLen) {
        bestLen = i - curStart;
        bestStart = curStart;
      }
      curStart = -1;
    }
  }
  const run = rec.frames.slice(bestStart, bestStart + bestLen);
  return measureContactSlide({ frames: run }, foot).horizontalM;
}

describe('travel walk — the footfall accent measured on the rig', () => {
  let accented: MotionRecording;
  let control: MotionRecording;
  let contacts: number[];

  beforeAll(() => {
    accented = sample(buildTravelWalk());
    control = sample({ ...buildTravelWalk(), heelStrikeAccent: false });
    contacts = contactInstants(buildTravelWalk(), accented);
  });

  it('the two runs share one time base (the accent never re-times anything)', () => {
    expect(accented.frames.length).toBe(control.frames.length);
    expect(accented.frames.map((f) => f.tMs)).toEqual(control.frames.map((f) => f.tMs));
    expect(contacts.length, 'the walk has real mid-motion contact instants').toBeGreaterThanOrEqual(2);
  });

  it('root-Y dips 0.3-1.2 cm within ~120 ms after EACH contact instant', () => {
    for (const c of contacts) {
      let maxDip = 0;
      let dipAtMs = 0;
      for (let i = 0; i < accented.frames.length; i += 1) {
        const t = accented.frames[i]!.tMs;
        if (t <= c || t > c + 120) continue;
        const dip = control.frames[i]!.root.translateM[1] - accented.frames[i]!.root.translateM[1];
        if (dip > maxDip) {
          maxDip = dip;
          dipAtMs = t - c;
        }
      }
      // eslint-disable-next-line no-console
      console.log(`heel-strike @${c.toFixed(0)}ms: dip ${(maxDip * 100).toFixed(2)}cm, ${dipAtMs.toFixed(0)}ms after contact`);
      expect(maxDip, `measurable accent after the contact @${c.toFixed(0)}ms`).toBeGreaterThan(0.003);
      expect(maxDip, `subtle accent after the contact @${c.toFixed(0)}ms`).toBeLessThan(0.012);
    }
  });

  it('outside the accent spans the walk is BYTE-IDENTICAL — the accent touches nothing else', () => {
    const inSpan = (t: number): boolean =>
      contacts.some((c) => t > c - 1 && t < c + HEEL_STRIKE_SPAN_MS + 1);
    let compared = 0;
    for (let i = 0; i < accented.frames.length; i += 1) {
      const t = accented.frames[i]!.tMs;
      if (inSpan(t)) continue;
      expect(JSON.stringify(accented.frames[i]), `frame @${t.toFixed(0)}ms untouched`).toBe(
        JSON.stringify(control.frames[i]),
      );
      compared += 1;
    }
    expect(compared, 'the comparison covered most of the walk').toBeGreaterThan(accented.frames.length * 0.7);
  });

  it('the smoothed-vertical quality gates hold WITH the accent: p2p < 10 cm, no >6 cm drop per 100 ms', () => {
    const ys = accented.frames.map((f) => f.root.translateM[1]);
    const p2p = Math.max(...ys) - Math.min(...ys);
    const total = accented.frames[accented.frames.length - 1]!.tMs;
    const perMs = total / (ys.length - 1);
    const win = Math.max(1, Math.round(100 / perMs));
    let maxDrop = 0;
    for (let i = win; i < ys.length; i += 1) maxDrop = Math.max(maxDrop, ys[i - win]! - ys[i]!);
    // eslint-disable-next-line no-console
    console.log(`accented vertical: p2p ${(p2p * 100).toFixed(1)}cm · max 100ms drop ${(maxDrop * 100).toFixed(1)}cm`);
    expect(p2p, 'overall vertical excursion stays calm').toBeLessThan(0.1);
    expect(maxDrop, 'the accent stays a transient — no sudden-drop regression').toBeLessThan(0.06);
  });

  it('the stance feet stay planted — the dip is absorbed by the leg IK, not the foot', () => {
    expect(plantedSlideM(accented, 'R_Foot'), 'R stance slide').toBeLessThan(0.03);
    expect(plantedSlideM(accented, 'L_Foot'), 'L stance slide').toBeLessThan(0.03);
  });

  it('is deterministic — two accented samples are byte-identical', () => {
    const again = sample(buildTravelWalk());
    expect(JSON.stringify(again.frames)).toBe(JSON.stringify(accented.frames));
  });
});

describe('non-gait motions carry NO accent', () => {
  it('the in-place walk (no stance schedule) is byte-identical with and without the flag', () => {
    const walk = () => templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);
    const a = sample(walk(), 30);
    const b = sample({ ...walk(), heelStrikeAccent: false }, 30);
    expect(JSON.stringify(a.frames)).toBe(JSON.stringify(b.frames));
  });
});
