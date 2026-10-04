import * as THREE from 'three';
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import { applyCustomPose, buildBoneByPoseKey } from './poseRig';
import type { CustomPose } from '../types';
import { createPosedVertexReader } from './posedGeometry';
import { createStageTwistOverlay } from './stageTwistOverlay';
import { clampContactHingeToRom } from './poseRomClamp';
import type { JointAngleRestReference } from './jointAngles';
import type { RomScenarioConstraints } from './romConstraints';

type Side = 'L' | 'R';
type Region = 'knee' | 'foot' | 'calf';
type SkinPoint = { side: Side; region: Region; point: THREE.Vector3 };

/** Transfers the measured support construction from Blender's
 * flexion-kneeling-authoring-1. The knee and dorsal foot share a plane by a
 * sagittal placement of the WHOLE body. Geometric placement preserves local
 * joints; an optional clinical reference first projects out-of-range knees.
 * This is geometric support, not dynamics or
 * a compression model. Opt in only for prepared bilateral kneeling motions. */
export function createKneelingSkinSupport(options: {
  root: THREE.Object3D; skinned: THREE.SkinnedMesh; variantCfg: BodyVariantConfig;
  baselinePose?: CustomPose;
  rest?: JointAngleRestReference;
  constraints?: () => RomScenarioConstraints | null | undefined;
}) {
  const { root, skinned, variantCfg } = options;
  const bones = buildBoneByPoseKey(skinned.skeleton, variantCfg);
  const knees = { L: bones.get('L_Leg')!, R: bones.get('R_Leg')! };
  if (!knees.L || !knees.R) throw Error('Kneeling support requires both knees');
  const points: Record<Side, [number, number, number]> = { L: [0, 0, 0], R: [0, 0, 0] };
  const refs: { skin: THREE.SkinnedMesh; vertex: number; side: Side; region: Region }[] = [];
  root.traverse(object => {
    const skin = object as THREE.SkinnedMesh;
    if (!skin.isSkinnedMesh || !skin.skeleton.bones.includes(knees.L)) return;
    const indices = skin.geometry.getAttribute('skinIndex'), weights = skin.geometry.getAttribute('skinWeight');
    const owners = skin.skeleton.bones.map(bone => {
      const side: Side | null = bone.name.includes('_L_') ? 'L' : bone.name.includes('_R_') ? 'R' : null;
      if (!side) return null;
      if (bone.name.includes('KneeShareBone')) return { side, region: 'knee' as const };
      let current: THREE.Object3D | null = bone;
      while (current && current !== bones.get(`${side}_Foot`)) current = current.parent;
      if (current) return { side, region: 'foot' as const };
      return bone.name.includes('Calf') ? { side, region: 'calf' as const } : null;
    });
    for (let vertex = 0; vertex < indices.count; vertex++) {
      let dominant = 0;
      for (let slot = 1; slot < weights.itemSize; slot++) {
        if (weights.getComponent(vertex, slot) > weights.getComponent(vertex, dominant)) dominant = slot;
      }
      const owner = owners[indices.getComponent(vertex, dominant)];
      if (owner) refs.push({ skin, vertex, ...owner });
    }
  });
  for (const side of ['L', 'R'] as const) for (const region of ['knee', 'foot'] as const) {
    if (!refs.some(ref => ref.side === side && ref.region === region)) throw Error(`Missing measured kneeling ${side} ${region} skin`);
  }
  const twist = createStageTwistOverlay();
  const saved = skinned.skeleton.bones.map(bone => bone.quaternion.clone());
  if (options.baselinePose) applyCustomPose(skinned.skeleton, variantCfg, options.baselinePose);
  twist.reset(skinned.skeleton, variantCfg);
  skinned.skeleton.bones.forEach((bone, index) => bone.quaternion.copy(saved[index]!));
  root.updateWorldMatrix(true, true);
  const reader = createPosedVertexReader();
  const center = () => knees.L.getWorldPosition(new THREE.Vector3()).add(knees.R.getWorldPosition(new THREE.Vector3())).multiplyScalar(.5);

  function prepare() {
    // Authored degrees and measured hinge degrees differ slightly on the rigs.
    // Project only an out-of-range knee using the existing measured clinical
    // projector before geometric placement; never extend its allowed range.
    if (options.rest) for (const side of ['L', 'R'] as const) {
      clampContactHingeToRom(bones.get(`${side}_UpLeg`)!, knees[side], `${side}_Leg`, options.rest, options.constraints?.());
    }
    root.updateWorldMatrix(true, true);
    const pivot = center();
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()));
    axis.y = 0;
    if (axis.lengthSq() < 1e-8) throw Error('Kneeling support requires a horizontal sagittal axis');
    axis.normalize();
    const measured: SkinPoint[] = twist.sampleWithTwist(() => {
      root.updateWorldMatrix(true, true); reader.beginMeasurement();
      return refs.map(ref => ({ side: ref.side, region: ref.region,
        point: reader.getVertexPosition(ref.skin, ref.vertex, new THREE.Vector3()).applyMatrix4(ref.skin.matrixWorld) }));
    });
    root.updateWorldMatrix(true, true);
    const heights = measured.map(ref => {
      const offset = ref.point.clone().sub(pivot);
      return { region: ref.region, y: offset.y, crossY: axis.z * offset.x - axis.x * offset.z };
    });
    const residual = (angle: number) => {
      const c = Math.cos(angle), s = Math.sin(angle);
      let knee = Infinity, foot = Infinity;
      for (const point of heights) {
        const y = point.y * c + point.crossY * s;
        if (point.region === 'knee') knee = Math.min(knee, y);
        if (point.region === 'foot') foot = Math.min(foot, y);
      }
      return foot - knee;
    };
    // Same stated geometric search as the editable Blender proposal. This
    // interval bounds placement, not a clinical joint range. Prefer the nearest
    // root and leave an already supported pose alone on repeated grounding.
    let angle = 0;
    if (Math.abs(residual(0)) > 1e-8) {
      const roots: number[] = [];
      let lo = -Math.PI / 4, flo = residual(lo);
      for (let step = 1; step <= 180; step++) {
        const hi = (-45 + step * .5) * Math.PI / 180, fhi = residual(hi);
        if (flo * fhi <= 0) {
          let a = lo, b = hi, fa = flo;
          for (let iteration = 0; iteration < 30; iteration++) {
            const mid = (a + b) / 2, fm = residual(mid);
            if (fa * fm <= 0) b = mid;
            else { a = mid; fa = fm; }
          }
          roots.push((a + b) / 2);
        }
        lo = hi; flo = fhi;
      }
      if (!roots.length) throw Error('No common knee and foot skin support in the authored placement range');
      angle = roots.reduce((best, value) => Math.abs(value) < Math.abs(best) ? value : best);
    }
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    if (angle !== 0) {
      const parent = root.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
      root.quaternion.premultiply(parent.clone().invert().multiply(rotation).multiply(parent));
      root.updateWorldMatrix(true, true);
      const worldPosition = root.getWorldPosition(new THREE.Vector3()).add(pivot.clone().sub(center()));
      root.position.copy(root.parent ? root.parent.worldToLocal(worldPosition) : worldPosition);
      root.updateWorldMatrix(true, true);
    }
    const minima = { L: Infinity, R: Infinity };
    for (const side of ['L', 'R'] as const) {
      let witness: THREE.Vector3 | undefined;
      for (const ref of measured) {
        if (ref.side !== side) continue;
        const point = ref.point.clone().sub(pivot).applyQuaternion(rotation).add(pivot);
        if (point.y < minima[side]) { minima[side] = point.y; witness = point; }
      }
      if (!witness) throw Error(`Missing ${side} kneeling surface witness`);
      knees[side].worldToLocal(witness).toArray(points[side]);
    }
    return { rotationDeg: angle * 180 / Math.PI, kneeFootHeightDifferenceM: residual(angle), minimumY: minima };
  }
  return { prepare, points };
}
