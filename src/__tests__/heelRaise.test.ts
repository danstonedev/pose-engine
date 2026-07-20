/**
 * HEEL-RAISE grounding gate. A bilateral heel-raise is a planted, in-place,
 * no-contacts motion — which ARMS the foot-rooted re-plant (`composedUseFootRoot`).
 * If `plantStanceFoot` fired it would restore the stance foot's rest ORIENTATION,
 * levelling the foot and cancelling the raise. The whole template only works if the
 * stance-foot drift stays under the re-root threshold so each frame falls through to
 * the vertical floor-pin, which lifts the body as the forefoot becomes the pivot.
 *
 * This proves, on the real rig: (1) the authored plantarflexion is measured back,
 * (2) the stance-foot drift stays < FOOT_ROOT_DRIFT_M (so the pin path runs, not the
 * re-root), and (3) the body RISES at the top of the raise (the heel lifts) and
 * returns to flat — i.e. the closed-chain heel-raise actually happens.
 *
 * MTP HINGE (toe rocker, wave 1): the template used to rise EN-POINTE — pure
 * plantarflexion with rigid toes continuing the foot line (a ballet relevé), an
 * actual clinical-content defect. A heel raise hinges at the MTP joints: heel up,
 * toe pads planted, MTP extended by ~the plantarflexion angle. The template now
 * authors toeFlexion (+40° = MTP extension) through the raise, so this gate ALSO
 * asserts the measured MTP extension at the top and its return to neutral — the
 * NEW expected behaviour, superseding the old en-pointe shape.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { captureFootFrames, stanceFootDrift, type FootFrameReference } from '../services/rootMotion';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
const FOOT_ROOT_DRIFT_M = 0.05; // must mirror the sampler/stage threshold

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let footFrames: FootFrameReference;
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
  footFrames = captureFootFrames(skinned.skeleton, variantCfg);
  rootRest0 = root.position.clone();
  rootQuat0 = root.quaternion.clone();
});

describe('heel-raise: floor-pin (not foot-root) lifts the body onto the toes', () => {
  it('measures the plantarflexion, stays on the pin, and raises the body', () => {
    const template = MOVEMENT_TEMPLATES.find((t) => t.id === 'heel-raise')!;
    expect(template, 'heel-raise template exists').toBeTruthy();
    const motion = templateToComposedMotion(template);
    const rec = sampleComposedMotion(resolveComposedMotion(motion, variantCfg), {
      baselinePose,
      variantCfg,
      rest,
      skeletonHarness: { root, skinned },
      sampleHz: 60,
    });

    // The top of the raise = the deepest plantarflexion (most NEGATIVE ankleFlexion).
    let top = rec.frames[0]!;
    let minAnkle = Infinity;
    for (const f of rec.frames) {
      const a = (f.angles as Record<string, Record<string, number>>).L_Foot?.ankleFlexion ?? 0;
      if (a < minAnkle) {
        minAnkle = a;
        top = f;
      }
    }

    // 1. The authored −35° plantarflexion is measured back (ROM allows −50°, so it is
    //    not clamped; tolerance covers measurement + the intra-phase settle).
    expect(minAnkle, 'peak plantarflexion measured').toBeLessThan(-25);

    // 2. The stance-foot drift at the top stays UNDER the re-root threshold — so the
    //    sampler kept it on the vertical pin, not `plantStanceFoot` (which would level
    //    the foot). Re-derive it by applying the top pose pelvis-rooted and measuring.
    root.position.copy(rootRest0);
    root.quaternion.copy(rootQuat0);
    applyCustomPose(skinned.skeleton, variantCfg, top.pose);
    root.updateMatrixWorld(true);
    const drift = stanceFootDrift(root, skinned.skeleton, variantCfg, footFrames)!;
    // eslint-disable-next-line no-console
    console.log(
      `heel-raise: peak ankle ${minAnkle.toFixed(0)}°, stance-foot drift ${(drift * 100).toFixed(1)}cm (threshold ${FOOT_ROOT_DRIFT_M * 100}cm), top rise ${(top.root.translateM[1] * 100).toFixed(1)}cm`,
    );
    expect(drift, 'stance-foot drift below re-root threshold').toBeLessThan(FOOT_ROOT_DRIFT_M);

    // 3. The body RISES at the top (the forefoot is the pivot, the heel + body lift) —
    //    the closed-chain heel-raise actually happened — and returns to flat at the ends.
    expect(top.root.translateM[1], 'body rises at the top of the raise').toBeGreaterThan(0.02);
    expect(Math.abs(rec.frames[0]!.root.translateM[1]), 'flat at the start').toBeLessThan(0.01);
    expect(
      Math.abs(rec.frames[rec.frames.length - 1]!.root.translateM[1]),
      'flat at the end',
    ).toBeLessThan(0.01);

    // 4. MTP HINGE (new expectation — supersedes the old en-pointe raise, which was a
    //    clinical-content defect): at the top of the raise the foot hinges at the ball —
    //    the MTP is EXTENDED (authored +40°, toe pads flat while the heel is up), and it
    //    returns to neutral once the foot is flat again. Tolerance covers measurement +
    //    the intra-phase settle, as with the ankle in (1).
    for (const toeKey of ['L_Toes', 'R_Toes'] as const) {
      const topToe = (top.angles as Record<string, Record<string, number>>)[toeKey]?.toeFlexion ?? 0;
      expect(topToe, `${toeKey} MTP extended at the top (hinge at the ball, not en-pointe)`).toBeGreaterThan(30);
      const lastToe =
        (rec.frames[rec.frames.length - 1]!.angles as Record<string, Record<string, number>>)[toeKey]
          ?.toeFlexion ?? 0;
      expect(Math.abs(lastToe), `${toeKey} MTP back to neutral when flat`).toBeLessThan(5);
    }
  });
});
