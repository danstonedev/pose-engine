/**
 * POSTURE TRANSITIONS (Phase 2) — the model physically gets into position between
 * movements that live in different postures. This pins: (1) the pure planner (BFS
 * over the posture graph); and, on the rig, (2) lie-down actually reaches SUPINE and
 * the body grounds near the floor; (3) a full chain standing → lie down → supine
 * leg-raise → stand up flows with no root teleport at the seams; (4) stand-up
 * returns the body upright.
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
import { sampleMotionChain } from '../services/movementChain';
import {
  planPosturePath,
  POSTURE_EDGES,
  movementStartPosture,
  movementEndPosture,
} from '../services/posturePlan';
import { POSTURE_NODES } from '../services/motionSequence';
import {
  buildLieDown,
  buildGetUp,
  buildSupineLegRaise,
  buildSitDown,
  buildStandFromSit,
} from '../services/movementTemplates';
import { measureCommandMotion } from '../services/movementCommand';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const pitchDeg = (q: [number, number, number, number]): number => {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]), 'YXZ');
  return (e.x * 180) / Math.PI;
};

describe('planPosturePath — the posture graph (pure)', () => {
  it('is empty when already at the target posture', () => {
    expect(planPosturePath('standing', 'standing')).toEqual([]);
    expect(planPosturePath('supine', 'supine')).toEqual([]);
  });

  it('routes standing↔supine to the lie-down / stand-up transitions', () => {
    const down = planPosturePath('standing', 'supine');
    expect(down?.length).toBe(1);
    expect(down![0]!.endPosture).toBe('supine');
    const up = planPosturePath('supine', 'standing');
    expect(up?.length).toBe(1);
    expect(up![0]!.endPosture).toBe('standing');
  });

  it('reaches the lying cluster by ROLLING (supine → side → prone), fully connected', () => {
    expect(planPosturePath('supine', 'sidelying-left')?.length).toBe(1); // one roll
    expect(planPosturePath('supine', 'prone')?.length).toBe(2); // roll to a side, then to the front
    // every posture node is now reachable from standing (no dead nodes).
    for (const p of ['sidelying-left', 'sidelying-right', 'prone', 'quadruped', 'kneeling', 'plank', 'sitting', 'supine'] as const) {
      expect(planPosturePath('standing', p), p).not.toBeNull();
    }
  });

  it('defaults an untagged movement to standing→standing', () => {
    expect(movementStartPosture({})).toBe('standing');
    expect(movementEndPosture({})).toBe('standing');
    expect(movementEndPosture({ startPosture: 'supine' })).toBe('supine'); // posture-preserving
    expect(POSTURE_EDGES.length).toBeGreaterThan(0);
  });

  it('POSTURE_NODES is the runtime list of every graph node (no drift with the edges)', () => {
    // The compose_motion start/endPosture schema enum is generated from POSTURE_NODES,
    // so every posture the executor can bridge to must appear here — and nothing else.
    const nodesInEdges = new Set<string>();
    for (const e of POSTURE_EDGES) { nodesInEdges.add(e.from); nodesInEdges.add(e.to); }
    for (const n of nodesInEdges) expect(POSTURE_NODES, `edge node ${n} listed`).toContain(n);
    // No duplicates, and 'standing' (the hub, never an authored edge target's only home) is present.
    expect(new Set(POSTURE_NODES).size).toBe(POSTURE_NODES.length);
    expect(POSTURE_NODES).toContain('standing');
  });
});

describe('posture transfers on the rig', () => {
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

  const runChain = (motions: ReturnType<typeof buildLieDown>[]) =>
    sampleMotionChain(motions, { baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30 });

  it('lie down REACHES supine and the body grounds near the floor', () => {
    const [down] = runChain([buildLieDown()]);
    expect(down!.status).toBe('ok');
    const last = down!.recording.frames.at(-1)!;
    const pitch = pitchDeg(last.root.orientQuat);
    const first = down!.recording.frames[0]!;
    const standHipsY = first.worldTracks!.Hips![1];
    const lieHipsY = last.worldTracks!.Hips![1];
    // eslint-disable-next-line no-console
    console.log(`lie down: end pitch ${pitch.toFixed(0)}°, Hips Y ${standHipsY.toFixed(2)}→${lieHipsY.toFixed(2)} m`);
    expect(pitch, 'ends supine (pitch ≈ −90)').toBeLessThan(-70);
    expect(lieHipsY, 'the pelvis is down near the floor when lying').toBeLessThan(standHipsY - 0.3);
  });

  it('a full stand → lie down → supine leg-raise → stand up chain flows with no seam teleport', () => {
    const chain = runChain([buildLieDown(), buildSupineLegRaise({ side: 'R' }), buildGetUp()]);
    expect(chain.map((c) => c.status)).toEqual(['ok', 'ok', 'ok']);
    // No root snap at any seam (the whole point — the body transfers, never teleports).
    for (let i = 1; i < chain.length; i += 1) {
      // eslint-disable-next-line no-console
      console.log(`seam ${i}: root Δtranslate ${(chain[i]!.seamRootTranslateM * 100).toFixed(1)}cm, Δorient ${chain[i]!.seamRootOrientDeg.toFixed(0)}°`);
      expect(chain[i]!.seamRootTranslateM, `seam ${i} no translate teleport`).toBeLessThan(0.08);
    }
    // The supine leg raise actually raised the leg while lying (measured hip flexion).
    const slr = chain[1]!.recording;
    const rHip = slr.frames.map((f) => measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'R_UpLeg', 'hipFlexion') ?? 0);
    expect(Math.max(...rHip), 'the straight leg is raised in supine').toBeGreaterThan(45);
    // Stand-up returns the body upright.
    const endPitch = pitchDeg(chain[2]!.recording.frames.at(-1)!.root.orientQuat);
    // eslint-disable-next-line no-console
    console.log(`stand up: end pitch ${endPitch.toFixed(0)}°`);
    expect(Math.abs(endPitch), 'upright again after standing up').toBeLessThan(20);
  });
});

describe('posture graph — sitting (Phase 3 Tier A)', () => {
  it('routes standing↔sitting to the sit-down / stand-from-sit transfers', () => {
    const down = planPosturePath('standing', 'sitting');
    expect(down?.length).toBe(1);
    expect(down![0]!.endPosture).toBe('sitting');
    const up = planPosturePath('sitting', 'standing');
    expect(up?.length).toBe(1);
    expect(up![0]!.startPosture).toBe('sitting');
    expect(up![0]!.endPosture).toBe('standing');
  });
});

describe('sitting grounds on the pelvis (Phase 3 Tier A, on the rig)', () => {
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

  it('sit down lands the pelvis at seat height, and the sit↔stand chain is smooth', () => {
    const chain = sampleMotionChain([buildSitDown(), buildStandFromSit()], {
      baselinePose,
      variantCfg,
      rest,
      skeletonHarness: { root, skinned },
      sampleHz: 30,
    });
    expect(chain.map((c) => c.status)).toEqual(['ok', 'ok']);
    const sit = chain[0]!.recording;
    const hipsY = (f: (typeof sit.frames)[number]) => f.worldTracks!.Hips![1];
    const standHipsY = hipsY(sit.frames[0]!);
    const seatedHipsY = hipsY(sit.frames.at(-1)!);
    // Seated pelvis is well below standing but well above the floor — on a seat.
    expect(seatedHipsY, 'pelvis drops toward a seat').toBeLessThan(standHipsY - 0.35);
    expect(seatedHipsY, 'pelvis is at seat height, not on the floor').toBeGreaterThan(0.4);
    // The grounding switch (feet → pelvis) does not pop.
    const sy = sit.frames.map(hipsY);
    let maxJump = 0;
    for (let i = 1; i < sy.length; i += 1) maxJump = Math.max(maxJump, Math.abs(sy[i]! - sy[i - 1]!));
    expect(maxJump, 'no pop at the grounding switch').toBeLessThan(0.05);
    // Stand-up returns the pelvis to standing height with no seam teleport.
    expect(chain[1]!.seamRootTranslateM, 'sit→stand seam has no teleport').toBeLessThan(0.05);
    const standEndHipsY = hipsY(chain[1]!.recording.frames.at(-1)!);
    expect(standEndHipsY, 'back to standing pelvis height').toBeGreaterThan(standHipsY - 0.08);
  });
});
