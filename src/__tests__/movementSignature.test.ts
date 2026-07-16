/**
 * MOVEMENT SIGNATURE GATE (simMOVE Phase 1) — the permanent regression proving
 * the deterministic scorer ACCEPTS a faithful reproduction of each simple
 * template and REJECTS the three ways a movement goes wrong: a per-joint
 * sign-flip (a reversal), a gross amplitude miss, and a coordination (peak-order)
 * scramble — while tolerating small within-tolerance jitter.
 *
 * Everything is RIG-DERIVED: reference signatures come from sampling
 * templateToComposedMotion on the real male GLB (never hand-typed), and every
 * mutation is played back through the same sampler, so a rejection is because
 * the MEASURED kinematics changed, not because of a bookkeeping trick.
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
import {
  resolveComposedMotion,
  type ComposedMotion,
  type SequenceKeyframe,
} from '../services/motionSequence';
import { sampleComposedMotion, exportKinematics } from '../services/motionRecording';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import {
  buildSignatureFromExport,
  driverKeysOf,
  scoreAgainstSignature,
  type KinematicSignature,
  type SignatureSourceExport,
} from '../services/movementSignature';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;

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
});

/** Sample a composed motion on the rig and return its kinematic export. */
function exportOf(m: ComposedMotion): SignatureSourceExport {
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status, `resolve ${m.name}`).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 30,
  });
  return exportKinematics(rec);
}

function templateMotion(id: string): ComposedMotion {
  const t = MOVEMENT_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`no template ${id}`);
  return templateToComposedMotion(t);
}

/** Reference signature for a template, fingerprinted on the joints IT DRIVES. */
function referenceOf(id: string): { sig: KinematicSignature; drivers: string[] } {
  const m = templateMotion(id);
  const drivers = driverKeysOf(m);
  const sig = buildSignatureFromExport(exportOf(m), { joints: drivers });
  return { sig, drivers };
}

// ── mutation helpers (transform a plan; replayed through the SAME sampler) ────
type Xform = (t: { joint: string; motion: string; targetDegrees: number }) => number;
function mapTargets(m: ComposedMotion, keyMatch: string, xform: Xform): ComposedMotion {
  return {
    ...m,
    keyframes: m.keyframes.map((kf) => ({
      ...kf,
      targets: (kf.targets ?? []).map((t) =>
        `${t.joint}.${t.motion}` === keyMatch ? { ...t, targetDegrees: xform(t) } : t,
      ),
    })),
  };
}
const negate = (m: ComposedMotion, key: string) => mapTargets(m, key, (t) => -t.targetDegrees);
const scale = (m: ComposedMotion, key: string, f: number) => mapTargets(m, key, (t) => t.targetDegrees * f);

const SIMPLE = [
  'cervical-rotation',
  'shoulder-flexion-elevation',
  'shoulder-abduction-elevation',
  'lumbar-flexion-extension',
  'single-leg-stance',
] as const;

describe('reference signatures are rig-derived and sane', () => {
  it('captures each simple template with the expected driver joints + amplitudes', () => {
    const byId = Object.fromEntries(SIMPLE.map((id) => [id, referenceOf(id)]));

    // cervical rotation: one driver, bidirectional ~±70° (excursion ~140°).
    const neck = byId['cervical-rotation'].sig.primary.find((j) => j.key === 'Neck.rotation')!;
    expect(neck.excursionDeg).toBeGreaterThan(120);
    expect(neck.peakDeg).toBeGreaterThan(50);
    expect(neck.minDeg).toBeLessThan(-50);
    expect(neck.normPeakTime).toBeLessThan(neck.normTroughTime); // left(+) before right(−)

    // shoulder flexion: driver flexes ~120° positive.
    const shf = byId['shoulder-flexion-elevation'].sig.primary.find((j) => j.key === 'R_UpperArm.shoulderFlexion')!;
    expect(shf.excursionDeg).toBeGreaterThan(90);
    expect(shf.dominantSign).toBe(1);

    // lumbar: flex forward (+55) then extend (−20); driver is the SPINE, not the
    // arms (which the world-frame shoulder readout contaminates under trunk flex).
    const lo = byId['lumbar-flexion-extension'].sig.primary.find((j) => j.key === 'Spine_Lower.flexion')!;
    expect(lo.peakDeg).toBeGreaterThan(40);
    expect(lo.minDeg).toBeLessThan(-10);
    expect(byId['lumbar-flexion-extension'].sig.primary.every((j) => j.key.startsWith('Spine_'))).toBe(true);

    // single-leg stance: hip ~30, knee ~45, same side.
    const hip = byId['single-leg-stance'].sig.primary.find((j) => j.key === 'R_UpLeg.hipFlexion')!;
    const knee = byId['single-leg-stance'].sig.primary.find((j) => j.key === 'R_Leg.kneeFlexion')!;
    expect(hip.dominantSign).toBe(1);
    expect(knee.excursionDeg).toBeGreaterThan(30);
  });
});

describe('round-trip: a faithful reproduction is ACCEPTED', () => {
  for (const id of SIMPLE) {
    it(`${id} scores accepted against its own reference`, () => {
      const { sig, drivers } = referenceOf(id);
      const again = exportOf(templateMotion(id)); // deterministic re-sample
      const res = scoreAgainstSignature(again, sig, {}, { joints: drivers });
      expect(res.accepted, res.reasons.join('; ')).toBe(true);
      expect(res.score).toBeGreaterThan(0.99);
    });
  }
});

describe('REJECTS the three failure modes', () => {
  it('sign-flip (one-way): extending instead of flexing the shoulder is rejected', () => {
    const { sig, drivers } = referenceOf('shoulder-flexion-elevation');
    const flipped = negate(templateMotion('shoulder-flexion-elevation'), 'R_UpperArm.shoulderFlexion');
    const res = scoreAgainstSignature(exportOf(flipped), sig, {}, { joints: drivers });
    expect(res.accepted).toBe(false);
    expect(res.joints.find((j) => j.key === 'R_UpperArm.shoulderFlexion')!.status).toBe('sign-flipped');
  });

  it('sign-flip (bidirectional): rotating the neck the other way FIRST is rejected', () => {
    const { sig, drivers } = referenceOf('cervical-rotation');
    // Negating the neck target swaps which side is reached first, reversing the
    // peak↔trough ORDER — caught by the sign term's order check for a symmetric
    // bidirectional motion (robust regardless of extrema spacing; red-team L1).
    const flipped = negate(templateMotion('cervical-rotation'), 'Neck.rotation');
    const res = scoreAgainstSignature(exportOf(flipped), sig, {}, { joints: drivers });
    expect(res.accepted).toBe(false);
    expect(res.joints.find((j) => j.key === 'Neck.rotation')!.status).toBe('sign-flipped');
  });

  it('vacuous reference (driver allowlist matched nothing) is never an accept-all', () => {
    // A typo'd / drifted allowlist yields an empty signature; the guard must
    // refuse to validate against it rather than passing every candidate.
    const bogus = buildSignatureFromExport(exportOf(templateMotion('shoulder-flexion-elevation')), {
      joints: ['NoSuch.joint'],
    });
    expect(bogus.primary).toHaveLength(0);
    const res = scoreAgainstSignature(exportOf(templateMotion('cervical-rotation')), bogus);
    expect(res.accepted).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/vacuous/);
  });

  it('gross amplitude miss: a shoulder that barely lifts is rejected', () => {
    const { sig, drivers } = referenceOf('shoulder-flexion-elevation');
    const weak = scale(templateMotion('shoulder-flexion-elevation'), 'R_UpperArm.shoulderFlexion', 0.3);
    const res = scoreAgainstSignature(exportOf(weak), sig, {}, { joints: drivers });
    expect(res.accepted).toBe(false);
    expect(res.joints.find((j) => j.key === 'R_UpperArm.shoulderFlexion')!.status).toBe('amplitude-off');
  });

  it('coordination scramble: two joints peaking in the WRONG order is rejected', () => {
    // Synthetic 2-joint motion: hip peaks early, knee late. Reference vs a plan
    // that swaps the order (knee early, hip late) — same amplitudes, wrong timing.
    const kf = (targets: { joint: string; motion: string; targetDegrees: number }[], durationMs: number): SequenceKeyframe => ({ targets, durationMs });
    const hipEarly: ComposedMotion = {
      name: 'hip-then-knee', stance: 'floating',
      keyframes: [
        kf([{ joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 40 }], 500),
        kf([{ joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 40 }, { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 40 }], 500),
      ],
    };
    const kneeEarly: ComposedMotion = {
      name: 'knee-then-hip', stance: 'floating',
      keyframes: [
        kf([{ joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 40 }], 500),
        kf([{ joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 40 }, { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 40 }], 500),
      ],
    };
    const drivers = ['R_Leg.kneeFlexion', 'R_UpLeg.hipFlexion'];
    const refSig = buildSignatureFromExport(exportOf(hipEarly), { joints: drivers });
    const res = scoreAgainstSignature(exportOf(kneeEarly), refSig, {}, { joints: drivers });
    expect(res.accepted).toBe(false);
    expect(res.joints.some((j) => j.status === 'timing-off')).toBe(true);
  });

  it('reversed root travel is rejected (unit — synthetic export)', () => {
    const fwd: SignatureSourceExport = { timesMs: [0, 500], series: {}, rootTranslateM: [[0, 0, 0], [0, 0, 0.4]], meta: { durationMs: 500 } };
    const back: SignatureSourceExport = { timesMs: [0, 500], series: {}, rootTranslateM: [[0, 0, 0], [0, 0, -0.4]], meta: { durationMs: 500 } };
    const refFwd = buildSignatureFromExport(fwd);
    expect(refFwd.travelSign[2]).toBe(1);
    const res = scoreAgainstSignature(back, refFwd);
    expect(res.accepted).toBe(false);
    expect(res.travel.find((t) => t.axis === 'z')!.ok).toBe(false);
  });
});

describe('TOLERATES within-tolerance jitter (not brittle)', () => {
  it('a slightly weaker-but-faithful shoulder flexion is still accepted', () => {
    const { sig, drivers } = referenceOf('shoulder-flexion-elevation');
    const jitter = scale(templateMotion('shoulder-flexion-elevation'), 'R_UpperArm.shoulderFlexion', 0.92);
    const res = scoreAgainstSignature(exportOf(jitter), sig, {}, { joints: drivers });
    expect(res.accepted, res.reasons.join('; ')).toBe(true);
  });
});
