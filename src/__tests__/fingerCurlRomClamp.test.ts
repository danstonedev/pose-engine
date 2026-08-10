/**
 * THE DIGITS' ROM, measured on the real rig.
 *
 * All ten digits have had a ROM row (curl 0–160, thumb 0–85), a live readout and
 * a ring gizmo since the registry was written, and nothing at all bounding them.
 * They are the one group `clampBoneToRom` cannot serve: its strategies decompose
 * a SINGLE bone's quaternion, but `fingerFlexion` is the signed sum of the MCP
 * and PIP angles in the curl plane, measured across two bones in world space. So
 * a curl drag ran to any angle — through the palm and out the far side — while
 * `hasClampStrategy` said "no strategy" and every call site treated that the
 * same as "nothing to do".
 *
 * The clamp therefore lives in `poseFingerRomClamp.ts`, written against the
 * readout instead of against a decomposition, and BOTH hosts call it — this
 * engine's stage posing layer and 3DPainMap's own copy of the same drag layer.
 * The tests below drive that shipped function, on the real rig, because a
 * synthetic three-bone stub would prove the arithmetic and not the thing that
 * actually matters: that the composite is linear enough in the control delta
 * for one rescale to land the bound.
 *
 * Per the pose-engine convention (see relaxedHands.test.ts) the rig is the male
 * runtime GLB in anatomic pose, with the rest reference captured off it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { buildBoneByPoseKey, distributeChainCurve } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  measureFingerFlexion,
  isFingerJointKey,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { getEffectiveRomRange } from '../services/romConstraints';
import { getRomFieldDefinition } from '../services/romRegistry';
import { romEnforcementFor } from '../services/poseRomClamp';
import { clampFingerCurlToRom } from '../services/poseFingerRomClamp';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;
const DIGITS = ['Thumb1', 'Index1', 'Mid1', 'Ring1', 'Pinky1'] as const;

describe('finger curl ROM — on the rig', () => {
  const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
  let root: THREE.Object3D;
  let skinned: THREE.SkinnedMesh;
  let rest: JointAngleRestReference;
  let bones: Map<string, THREE.Bone>;
  /** MCP→PIP→DIP chain + rest locals per digit — `buildFingerCurls`' output. */
  let chains: Map<string, { bones: THREE.Object3D[]; rest: THREE.Quaternion[] }>;

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
    bones = buildBoneByPoseKey(skinned.skeleton, variantCfg);

    // Mirror of stagePosingLayer.buildFingerCurls — the MCP plus its next two
    // bone descendants, with their rest locals.
    chains = new Map();
    for (const side of ['L_', 'R_'] as const) {
      for (const d of DIGITS) {
        const mcp = bones.get(`${side}${d}`);
        if (!mcp) continue;
        const chain: THREE.Object3D[] = [mcp];
        let node: THREE.Object3D = mcp;
        for (let i = 0; i < 2; i += 1) {
          const next = node.children.find((c) => (c as THREE.Bone).isBone);
          if (!next) break;
          chain.push(next);
          node = next;
        }
        chains.set(`${side}${d}`, {
          bones: chain,
          rest: chain.map((b) => (b as THREE.Bone).quaternion.clone()),
        });
      }
    }
  });

  const LOCAL_Z = new THREE.Vector3(0, 0, 1);

  /** The control target a curl ring drag of `deg` about the digit's local-Z
   *  produces — the same axis the driving-ring map pins for the digits. */
  function curlTarget(key: string, deg: number): THREE.Quaternion {
    const fc = chains.get(key)!;
    return fc.rest[0]
      .clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(LOCAL_Z, (deg * Math.PI) / 180));
  }

  function measure(key: string): number {
    root.updateMatrixWorld(true);
    return measureFingerFlexion(bones, key, rest)!;
  }

  function restoreRest(key: string): void {
    const fc = chains.get(key)!;
    fc.bones.forEach((b, i) => b.quaternion.copy(fc.rest[i]));
    root.updateMatrixWorld(true);
  }

  /** The SHIPPED clamp, driven directly — not a reproduction of it. Both hosts
   *  call this same export; all they add is the bone lookup, the rest
   *  reference, and the world-matrix refresh. */
  function clampFingerCurl(key: string, target: THREE.Quaternion): void {
    clampFingerCurlToRom(key, chains.get(key)!, target, bones, rest, {
      updateWorldMatrices: () => root.updateMatrixWorld(true),
    });
  }

  /** Drag `deg` of curl onto a digit exactly as the ring does, then clamp. */
  function dragAndClamp(key: string, deg: number): number {
    restoreRest(key);
    const target = curlTarget(key, deg);
    distributeChainCurve(chains.get(key)!.bones, chains.get(key)!.rest, 0, target);
    clampFingerCurl(key, target);
    return measure(key);
  }

  it('every digit is on the composite path, and none has a single-bone strategy', () => {
    for (const side of ['L_', 'R_'] as const) {
      for (const d of DIGITS) {
        const key = `${side}${d}`;
        expect(isFingerJointKey(key), `${key} must be recognised as a digit`).toBe(true);
        expect(romEnforcementFor(key)).toBe('composite-finger-curl');
      }
    }
  });

  /** What a drag of `deg` measures with NO clamp applied. */
  function unclampedAt(key: string, deg: number): number {
    restoreRest(key);
    const fc = chains.get(key)!;
    distributeChainCurve(fc.bones, fc.rest, 0, curlTarget(key, deg));
    return measure(key);
  }

  /** The unclamped extremes a ring drag can reach on a digit, both senses. */
  function unclampedReach(key: string): { min: number; max: number } {
    let lo = Infinity;
    let hi = -Infinity;
    for (let deg = -179; deg <= 179; deg += 1) {
      restoreRest(key);
      const fc = chains.get(key)!;
      distributeChainCurve(fc.bones, fc.rest, 0, curlTarget(key, deg));
      const v = measure(key);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    restoreRest(key);
    return { min: lo, max: hi };
  }

  it('an UNCLAMPED curl drag runs well past the 0 floor, into hyperextension', () => {
    // The defect, stated as a measurement rather than as a claim about code.
    //
    // What a drag can reach is bounded by the mechanism, not by any ROM: the
    // ring hands `distributeChainCurve` a delta-from-rest, which is a
    // quaternion and so tops out at 180° along the shortest path, and the
    // function slerps it by 1/3 onto each of the three phalanges while the
    // readout sums two of them — so the composite saturates near ±120°.
    //
    // That has a consequence worth recording: a single drag cannot push a
    // FINGER past its 160 ceiling, so the leak on this path is the floor, not
    // the ceiling — a fingertip driven to the back of the hand. The thumb's
    // 85 cap is inside the reachable band and leaks in both directions.
    for (const key of ['L_Index1', 'R_Index1', 'L_Thumb1', 'R_Thumb1'] as const) {
      const reach = unclampedReach(key);
      expect(reach.min, `${key} hyperextends well past the 0 floor`).toBeLessThan(-30);
      expect(reach.max, `${key} curls`).toBeGreaterThan(30);
    }
    for (const key of ['L_Thumb1', 'R_Thumb1'] as const) {
      const max = getRomFieldDefinition(key, 'fingerFlexion')!.range.max;
      expect(unclampedReach(key).max, `${key} past its 85 cap`).toBeGreaterThan(max);
    }
  });

  it('holds EVERY reachable drag inside the registry band, all ten digits', () => {
    // A SWEEP, not two extremes. Picking a couple of large drag angles reads
    // like a thorough test and is not one: a ring delta is a quaternion, so
    // "drag 400°" wraps to 40° along the shortest path and lands comfortably
    // in range without the clamp doing anything at all. Walking the whole
    // reachable band is the only version that cannot pass vacuously.
    for (const side of ['L_', 'R_'] as const) {
      for (const d of DIGITS) {
        const key = `${side}${d}`;
        const { min, max } = getRomFieldDefinition(key, 'fingerFlexion')!.range;
        let clampedSamples = 0;
        for (let deg = -179; deg <= 179; deg += 7) {
          const settled = dragAndClamp(key, deg);
          expect(settled, `${key} @ ${deg}° drag`).toBeGreaterThanOrEqual(min - 1);
          expect(settled, `${key} @ ${deg}° drag`).toBeLessThanOrEqual(max + 1);
          if (unclampedAt(key, deg) < min - 1 || unclampedAt(key, deg) > max + 1)
            clampedSamples += 1;
        }
        // …and the sweep must actually have HAD work to do on this digit.
        expect(clampedSamples, `${key} sweep exercised the clamp`).toBeGreaterThan(0);
        restoreRest(key);
      }
    }
  });

  it('caps the THUMB at 85, not at the fingers’ 160', () => {
    // The thumb is not a finger: two phalanges, CMC/MP/IP, and the shares that
    // realize a composite curl put its MP past an AAOS-normal 60° well before
    // 160. The registry says 85 for exactly that reason, so the clamp landing
    // on the shared 160 would be a silent anatomical regression.
    expect(getRomFieldDefinition('R_Thumb1', 'fingerFlexion')!.range.max).toBe(85);
    for (const key of ['L_Thumb1', 'R_Thumb1'] as const) {
      expect(dragAndClamp(key, 400), key).toBeLessThanOrEqual(86);
      restoreRest(key);
    }
  });

  it('holds hyperextension at the 0 floor (a digit does not bend backwards)', () => {
    // min is 0 on every digit row: the composite is a delta from rest, so 0 is
    // a straight digit and anything negative is the fingertip travelling to the
    // back of the hand.
    for (const key of ['L_Mid1', 'R_Mid1', 'L_Pinky1', 'R_Pinky1'] as const) {
      expect(getRomFieldDefinition(key, 'fingerFlexion')!.range.min).toBe(0);
      const settled = dragAndClamp(key, 400 * (key.startsWith('L_') ? 1 : -1));
      expect(settled, `${key} hyperextension`).toBeGreaterThanOrEqual(-1);
      restoreRest(key);
    }
  });

  it('leaves a WITHIN-range curl exactly where the drag put it', () => {
    // The clamp must be inert in the range the user spends all their time in,
    // or every ordinary drag gets quietly rescaled.
    for (const key of ['L_Index1', 'R_Index1', 'L_Ring1', 'R_Ring1'] as const) {
      restoreRest(key);
      const fc = chains.get(key)!;
      const target = curlTarget(key, key.startsWith('L_') ? -40 : 40);
      distributeChainCurve(fc.bones, fc.rest, 0, target);
      const before = measure(key);
      expect(before, `${key} test drag must land in range`).toBeGreaterThan(5);
      expect(before).toBeLessThan(getRomFieldDefinition(key, 'fingerFlexion')!.range.max);
      clampFingerCurl(key, target);
      expect(measure(key), `${key} untouched`).toBeCloseTo(before, 6);
      restoreRest(key);
    }
  });

  it('honours a scenario constraint that tightens the ceiling', () => {
    // A case-authored limit ("this index finger stops at 40°") has to bound the
    // drag exactly like a normative one, which is why the clamp reads
    // getEffectiveRomRange rather than the registry directly.
    const key = 'R_Index1';
    const tightened = getEffectiveRomRange(
      { [key]: { fingerFlexion: { availableRange: { max: 40 } } } },
      key,
      'fingerFlexion',
    );
    expect(tightened).toEqual({ min: 0, max: 40 });
  });

  it('the shipped clamp is wired into the finger drag branch', () => {
    // Source assertion, this repo's convention for interaction wiring that only
    // exists inside a live pointer handler. It pins the two things the local
    // reproduction above cannot: that the real handler CALLS the clamp on the
    // finger branch, and that the clamp reads its range through the scenario
    // constraint layer rather than straight off the registry.
    const layer = readFileSync(
      fileURLToPath(new URL('../services/stagePosingLayer.ts', import.meta.url)),
      'utf-8',
    );
    expect(layer).toMatch(
      /distributeChainCurve\(fc\.bones, fc\.rest, 0, target\); \/\/ finger curl\s*\n\s*clampFingerCurl\(selected\.key, fc, target\);/,
    );
    expect(layer).toMatch(
      /clampFingerCurlToRom\(key, fc, target, stageCtx\.motionCapBones, stageCtx\.restRef, \{/,
    );
    // …and it must hand over the scenario constraints, or a case-authored limit
    // binds the gizmo path and not the drag.
    expect(layer).toMatch(/constraints: stageCtx\.romConstraints \?\? null,/);
  });

  it('the pelvis drag clamps before it plants the feet', () => {
    // The other path that skipped the clamp outright. Hips HAS a strategy, so
    // this was never a missing-strategy gap — the ring-drag branch just wrote
    // the target straight onto the bone. Order matters: clamping after the
    // plant would leave the legs solved against a pelvis the user does not end
    // up with.
    const layer = readFileSync(
      fileURLToPath(new URL('../services/stagePosingLayer.ts', import.meta.url)),
      'utf-8',
    );
    const branch = layer.match(
      /else if \(selected\.key === 'Hips'\) \{[\s\S]*?applyPelvisPlant\(\);/,
    )?.[0];
    expect(branch, 'Hips ring-drag branch').toBeTruthy();
    expect(branch!.indexOf('poseClamp(selected.bone, selected.key);')).toBeGreaterThan(-1);
    expect(branch!.indexOf('poseClamp(')).toBeLessThan(branch!.indexOf('applyPelvisPlant()'));
  });
});
