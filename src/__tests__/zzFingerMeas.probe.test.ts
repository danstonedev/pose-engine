/* TEMPORARY probe — verifying the signed/in-plane/rest-referenced measurement. Delete. */
import { beforeAll, describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { buildBoneByPoseKey } from '../services/poseRig';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const RAD = Math.PI / 180;
const PIP_SHARE = 0.65;
const DIP_SHARE = 0.45;

interface Rig {
  root: THREE.Object3D;
  sk: THREE.SkinnedMesh;
  lk: Map<string, THREE.Bone>;
  an: Map<THREE.Bone, THREE.Quaternion>;
  id: string;
}
async function load(id: 'male' | 'female'): Promise<Rig> {
  const cfg = BODY_VARIANTS[id];
  const buf = readFileSync(
    fileURLToPath(new URL(`../../models/painmap3D_${id}.runtime.glb`, import.meta.url)),
  );
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const g = await new Promise<{ scene: THREE.Group }>((r, j) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', r as never, j);
  });
  const root = g.scene;
  root.scale.setScalar(cfg.pose.rootScale);
  let sk!: THREE.SkinnedMesh;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !sk) sk = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, cfg);
  root.updateMatrixWorld(true);
  const lk = buildBoneByPoseKey(sk.skeleton, cfg);
  const an = new Map<THREE.Bone, THREE.Quaternion>();
  for (const b of sk.skeleton.bones) an.set(b, b.quaternion.clone());
  return { root, sk, lk, an, id };
}

/** Nearest descendant with a real offset — same rule as boneWorldDirection. */
function dirOf(bone: THREE.Bone): THREE.Vector3 | null {
  const here = bone.getWorldPosition(new THREE.Vector3());
  const q: THREE.Object3D[] = [...bone.children];
  let guard = 0;
  while (q.length && guard++ < 64) {
    const n = q.shift()!;
    const d = n.getWorldPosition(new THREE.Vector3()).sub(here);
    if (d.lengthSq() >= 1e-8) return d.normalize();
    q.push(...n.children);
  }
  return null;
}

/** SIGNED angle from p to d, measured in the plane whose normal is `axis`. */
function signedInPlane(p: THREE.Vector3, d: THREE.Vector3, axis: THREE.Vector3): number {
  const pp = p.clone().addScaledVector(axis, -p.dot(axis));
  const dd = d.clone().addScaledVector(axis, -d.dot(axis));
  if (pp.lengthSq() < 1e-10 || dd.lengthSq() < 1e-10) return 0;
  pp.normalize();
  dd.normalize();
  return Math.atan2(new THREE.Vector3().crossVectors(pp, dd).dot(axis), pp.dot(dd)) * (180 / Math.PI);
}

/** The proposed measurement, raw (before rest subtraction). */
function rawTerms(rig: Rig, key: string): { mcp: number; pip: number } | null {
  const side = key.slice(0, 2);
  const mcp = rig.lk.get(key);
  const hand = rig.lk.get(`${side}Hand`);
  if (!mcp || !hand) return null;
  const d1 = dirOf(mcp);
  if (!d1) return null;
  const pipBone = mcp.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined;
  const d2 = pipBone ? dirOf(pipBone) : null;
  const meta = mcp
    .getWorldPosition(new THREE.Vector3())
    .sub(hand.getWorldPosition(new THREE.Vector3()));
  // The curl axis: the MCP bone's own local +Z, in world.
  const axis = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(mcp.getWorldQuaternion(new THREE.Quaternion()))
    .normalize();
  const mcpDeg = meta.lengthSq() > 1e-8 ? signedInPlane(meta, d1, axis) : 0;
  const axis2 = pipBone
    ? new THREE.Vector3(0, 0, 1)
        .applyQuaternion(pipBone.getWorldQuaternion(new THREE.Quaternion()))
        .normalize()
    : axis;
  const pipDeg = d2 ? signedInPlane(d1, d2, axis2) : 0;
  return { mcp: mcpDeg, pip: pipDeg };
}

const DIGITS = ['Thumb1', 'Index1', 'Mid1', 'Ring1', 'Pinky1'] as const;

describe('proposed finger measurement', () => {
  let male: Rig, female: Rig;
  beforeAll(async () => {
    male = await load('male');
    female = await load('female');
  }, 60_000);

  it('is zero at rest and linear in the authored curl', () => {
    for (const rig of [male, female]) {
      console.log(`\n##### ${rig.id}`);
      for (const side of ['R_', 'L_'] as const) {
        const sign = side === 'R_' ? 1 : -1;
        for (const d of DIGITS) {
          const key = `${side}${d}`;
          const reset = () => {
            for (const [b, q] of rig.an) b.quaternion.copy(q);
            rig.root.updateMatrixWorld(true);
          };
          reset();
          const restT = rawTerms(rig, key)!;
          const rows: string[] = [];
          let worstRatio = 0;
          for (const full of [-30, 0, 30, 60, 90, 130, 176]) {
            reset();
            const base = key.slice(0, -1);
            for (const [k, amt] of [
              [`${base}1`, full * (1 - PIP_SHARE)],
              [`${base}2`, full * PIP_SHARE],
              [`${base}3`, full * DIP_SHARE],
            ] as [string, number][]) {
              const b = rig.lk.get(k);
              if (b)
                b.quaternion.multiply(
                  new THREE.Quaternion().setFromAxisAngle(
                    new THREE.Vector3(0, 0, 1),
                    sign * amt * RAD,
                  ),
                );
            }
            rig.root.updateMatrixWorld(true);
            const t = rawTerms(rig, key)!;
            const measured = sign * (t.mcp - restT.mcp + (t.pip - restT.pip));
            rows.push(`${full}->${measured.toFixed(2)}`);
            if (full !== 0) worstRatio = Math.max(worstRatio, Math.abs(measured / full - 1));
          }
          console.log(
            `${key.padEnd(10)} restOffset ${(sign * (restT.mcp + restT.pip)).toFixed(2).padStart(7)}  ` +
              `worstRatioErr ${(worstRatio * 100).toFixed(1)}%  ${rows.join(' ')}`,
          );
        }
      }
    }
  }, 300_000);
});
