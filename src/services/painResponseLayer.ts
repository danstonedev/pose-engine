import * as THREE from 'three';
import { PAIN_FACE_CHANNELS, type PainResponse } from './painResponse';
import { BODY_VARIANTS, type BodyVariantId } from '../anatomy/bodyVariants';
import { captureJointAngleRestReference, measureFingerFlexion } from './jointAngles';
import { buildBoneByPoseKey } from './poseRig';
import { getEffectiveRomRange, type RomScenarioConstraints } from './romConstraints';
import type { StageSceneContext } from './stageSceneLayer';

export interface PainFaceData {
  version: number; variant: string;
  primitives: { count: number; fingerprint: number; targets: { name: string; values: number[][] }[] }[];
}
export async function loadPainFaceData(variant: BodyVariantId): Promise<PainFaceData | undefined> {
  if (variant === 'male') return (await import('../assets/pain-face/male.json')).default;
  if (variant === 'female') return (await import('../assets/pain-face/female.json')).default;
  return undefined; // Neutral has different facial geometry; do not retarget by vertex count.
}
const fingerprint = (array: ArrayLike<number>) => {
  const floats = new Float32Array(Array.from(array));
  let h=2166136261; for (const value of new Uint8Array(floats.buffer)) h=Math.imul(h^value,16777619);
  return h>>>0;
};
/** Local per-stage skin deformation. Restored after drawing, before captures/contact resets.
 * Base positions, topology, UVs and skinning remain unchanged. No shared loader geometry is mutated.
 */
export function createPainResponseLayer(context: Pick<StageSceneContext, 'modelRoot' | 'skinnedMesh' | 'bone'>, variant: BodyVariantId, data?: PainFaceData) {
  const root = context.modelRoot;
  const skins: { mesh: THREE.SkinnedMesh; original: THREE.BufferGeometry; geometry: THREE.BufferGeometry; targets: PainFaceData['primitives'][number]['targets'] }[] = [];
  const undoSkin: { position: THREE.BufferAttribute; normal: THREE.BufferAttribute; p: Float32Array; n: Float32Array }[] = [];
  const undoBones = new Map<THREE.Object3D, THREE.Quaternion>();
  if (root && data?.variant === variant && data.version === 1) {
    root.traverse(object => {
      const mesh = object as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh || mesh.name.startsWith('pain-paint-')) return;
      const position = mesh.geometry.getAttribute('position');
      if (!(position instanceof THREE.BufferAttribute)) return;
      const primitive = data.primitives.find(p => p.count === position.count && p.fingerprint === fingerprint(position.array));
      if (!primitive || !primitive.targets.some(t=>t.values.length)) return;
      const original = mesh.geometry, geometry = original.clone();
      mesh.geometry = geometry;
      skins.push({mesh,original,geometry,targets:primitive.targets});
    });
  }
  const rest = context.skinnedMesh ? captureJointAngleRestReference(context.skinnedMesh.skeleton, BODY_VARIANTS[variant]) : null;
  const bones = context.skinnedMesh ? buildBoneByPoseKey(context.skinnedMesh.skeleton, BODY_VARIANTS[variant]) : new Map<string, THREE.Bone>();
  function restore() {
    for (const {position,normal,p,n} of undoSkin) { (position.array as Float32Array).set(p); (normal.array as Float32Array).set(n); position.needsUpdate=true; normal.needsUpdate=true; }
    undoSkin.length=0;
    for (const [bone, quaternion] of undoBones) bone.quaternion.copy(quaternion);
    undoBones.clear(); root?.updateMatrixWorld(true);
  }
  return {
    faceAvailable: skins.length > 0,
    apply(response: PainResponse, freeHands: readonly ('L'|'R')[] = [], constraints?: RomScenarioConstraints | null) {
      restore();
      if (!(response.activation > 0) || ![response.brow,response.browRaise,response.squint,response.eyeClosure,response.nose,response.mouth,response.jawOpen,response.mouthOpen,response.handClench].some(value=>value>0)) return;
      for (const {mesh,targets} of skins) {
        // Contact may temporarily replace a mesh's geometry for this draw.
        const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        const normal = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
        undoSkin.push({position,normal,p:new Float32Array(position.array),n:new Float32Array(normal.array)});
        for (const target of targets) {
          const channel = PAIN_FACE_CHANNELS[target.name as keyof typeof PAIN_FACE_CHANNELS];
          const weight = channel ? response[channel] : 0;
          if (!weight) continue;
          for (const [v,x,y,z] of target.values) position.setXYZ(v,position.getX(v)+x*weight,position.getY(v)+y*weight,position.getZ(v)+z*weight);
        }
        position.needsUpdate=true;
        mesh.geometry.computeVertexNormals();
      }
      if (rest && response.handClench > 0) for (const side of new Set(freeHands)) for (const digit of ['Thumb','Index','Mid','Ring','Pinky']) {
        const key = `${side}_${digit}1`, mcp=context.bone(key);
        if (!mcp) continue;
        const chain=[mcp];
        for(let n=0;n<2;n++) { const next=chain.at(-1)!.children.find(c=>(c as THREE.Bone).isBone); if(next) chain.push(next); }
        if(chain.length!==3) continue;
        const baseline=chain.map(b=>b.quaternion.clone());
        const before=measureFingerFlexion(bones,key,rest);
        const range=getEffectiveRomRange(constraints ?? null,key,'fingerFlexion');
        if (before===null || !range || before<range.min || before>=range.max) continue;
        const ceiling=Math.min(range.max,digit==='Thumb'?70:130);
        if(before>=ceiling) continue;
        const angle=THREE.MathUtils.degToRad((side==='L'?-1:1)*Math.min((digit==='Thumb'?15:50)*response.handClench,(ceiling-before)/2));
        for(const b of chain) { undoBones.set(b,b.quaternion.clone()); b.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),angle)); }
        root?.updateMatrixWorld(true);
        // Preserve an already posed hand, including scenario bounds. Never tighten past a limit.
        const measured=measureFingerFlexion(bones,key,rest);
        const fraction=measured===null || !Number.isFinite(measured) || measured<before ? 0 : measured>ceiling ? Math.max(0,(ceiling-before)/(measured-before)) : 1;
        if (fraction<1) chain.forEach((b,i)=>b.quaternion.copy(baseline[i]).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),angle*fraction)));
      }
      root?.updateMatrixWorld(true);
    },
    restore,
    dispose() {
      restore();
      for (const skin of skins) { if(skin.mesh.geometry===skin.geometry) skin.mesh.geometry=skin.original; skin.geometry.dispose(); }
    },
  };
}
