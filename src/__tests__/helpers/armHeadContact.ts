/** Conservative mesh envelope used only by reach regressions. Held neck/head
 * pose is required. This detects burial, not validated anatomical contact. */
import {Vector3, type Object3D, type SkinnedMesh} from 'three';
import {ConvexHull} from 'three/examples/jsm/math/ConvexHull.js';

export function armHeadContact(root: Object3D, neck: Object3D) {
 const head: Vector3[] = [], arms: Record<'L'|'R', {mesh: SkinnedMesh; index: number}[]> = {L:[],R:[]};
 const descendants = new Set<Object3D>(); neck.traverse(bone=>descendants.add(bone));
 const point = (mesh: SkinnedMesh,index: number,out=new Vector3()) => {
  out.fromBufferAttribute(mesh.geometry.getAttribute('position'),index);
  mesh.applyBoneTransform(index,out);return out.applyMatrix4(mesh.matrixWorld);
 };
 root.traverse(object=>{
  const mesh=object as SkinnedMesh;if(!mesh.isSkinnedMesh)return;
  const indices=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight');
  for(let i=0;i<indices.count;i++){
   let headWeight=0,max=0,name='';
   for(let j=0;j<4;j++) {
    const bone=mesh.skeleton.bones[indices.getComponent(i,j)]!,w=weights.getComponent(i,j);
    if(descendants.has(bone))headWeight+=w;if(w>max){max=w;name=bone.name;}
   }
   if(headWeight>.9)head.push(point(mesh,i));
   const arm=/_([LR])_(Upperarm|UpperarmTwist\d+|Forearm|ForearmTwist\d+|Hand|Index\d|Mid\d|Ring\d|Pinky\d|Thumb\d)$/.exec(name);
   if(arm&&max>.65)arms[arm[1] as 'L'|'R'].push({mesh,index:i});
  }
 });
 if(head.length<4||!arms.L.length||!arms.R.length)throw Error('Missing head/arm skin samples');
 const hull=new ConvexHull().setFromPoints(head),p=new Vector3();
 return (side:'L'|'R')=>{
  let penetration=0;
  for(const {mesh,index}of arms[side]){
   point(mesh,index,p);let margin=-Infinity;
   for(const f of hull.faces)margin=Math.max(margin,f.normal.dot(p)-f.constant);
   penetration=Math.max(penetration,-margin);
  }
  return penetration;
 };
}
