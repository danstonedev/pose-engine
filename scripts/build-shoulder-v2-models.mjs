/** Deterministic opt-in shoulder rig. Existing assets and atlas topology stay byte-identical. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Matrix4,Vector3} from 'three';
import {createRuntimeModelIO,snapshotRuntimeModel} from './runtime-model-snapshot.mjs';
const io=await createRuntimeModelIO(),sha=b=>createHash('sha256').update(b).digest('hex');
const manifest={version:'shoulder-rig-v2-engineering-1',calibration:'engineering-estimate-unreviewed',variants:{}};
for(const variant of ['male','female','neutral']){
 const input=`models/painmap3D_${variant}.runtime.glb`,output=`models/painmap3D_${variant}.shoulder-v2.glb`;
 const doc=await io.read(input),root=doc.getRoot(),skin=root.listSkins()[0],joints=skin.listJoints(),buffer=root.listBuffers()[0],before=snapshotRuntimeModel(doc);
 assert.equal(joints.length,101);assert.ok(!joints.some(n=>n.getName().includes('Scapula')));
 const ibm=skin.getInverseBindMatrices(),oldIBM=ibm.getArray().slice(),newIBM=new Float32Array(103*16);newIBM.set(oldIBM);
 const sides={},lookup=new Map(joints.map(n=>[n.getName(),n]));
 for(const side of ['L','R']){
  const clavicle=lookup.get(`CC_Base_${side}_Clavicle`),arm=lookup.get(`CC_Base_${side}_Upperarm`),armPosition=arm.getTranslation().slice(),gh=new Vector3(...arm.getWorldTranslation());
  // Keep the existing SC attachment. AC is an explicit provisional landmark,
  // 15 mm medial and 15 mm superior to the original GH origin in source world.
  const ac=gh.clone().add(new Vector3(side==='L'?-.015:.015,.015,0));
  const local=ac.clone().applyMatrix4(new Matrix4().fromArray(clavicle.getWorldMatrix()).invert());
  const scapula=doc.createNode(`CC_Base_${side}_Scapula`).setTranslation(local.toArray()).setExtras({rigVersion:manifest.version,calibration:manifest.calibration});
  clavicle.removeChild(arm);clavicle.addChild(scapula);scapula.addChild(arm);arm.setTranslation(new Vector3(...armPosition).sub(local).toArray());skin.addJoint(scapula);
  const index=skin.listJoints().indexOf(scapula),clavIndex=joints.indexOf(clavicle);
  const inv=new Matrix4().makeTranslation(-local.x,-local.y,-local.z).multiply(new Matrix4().fromArray(oldIBM,clavIndex*16));newIBM.set(inv.elements,index*16);
  sides[side]={index,scapula,arm,local:local.toArray(),originalArmPosition:armPosition,SC:clavicle.getWorldTranslation(),AC:ac.toArray(),GH:gh.toArray(),patchVertices:0,maxWeight:0,maxPrunedWeight:0};
 }
 skin.setInverseBindMatrices(doc.createAccessor('shoulder-v2-inverse-bind',buffer).setType('MAT4').setArray(newIBM));
 let maxBindDriftM=0;
 for(const meshNode of root.listNodes().filter(n=>n.getMesh()))for(const prim of meshNode.getMesh().listPrimitives()){
  const wa=prim.getAttribute('WEIGHTS_0'),ja=prim.getAttribute('JOINTS_0'),pa=prim.getAttribute('POSITION');if(!wa||!ja)continue;
  const oldWeights=wa.getArray().slice(),oldIndices=ja.getArray().slice();const newWeights=new Float32Array(oldWeights),newIndices=new Uint16Array(oldIndices);
  if(prim.getMaterial()?.getName()==='Std_Skin_Body')for(let v=0;v<pa.getCount();v++){
   const sourcePoint=new Vector3().fromArray(pa.getArray(),v*3),p=new Vector3();
   for(let k=0;k<4;k++){const j=oldIndices[v*4+k],matrix=new Matrix4().fromArray(joints[j].getWorldMatrix()).multiply(new Matrix4().fromArray(oldIBM,j*16));p.addScaledVector(sourcePoint.clone().applyMatrix4(matrix),oldWeights[v*4+k]);}
   const side=p.x>=0?'L':'R',entry=sides[side],gh=entry.GH;
   const dx=(Math.abs(p.x)-Math.abs(gh[0])*.60)/.085,dy=(p.y-(gh[1]-.095))/.13,dz=(p.z-(gh[2]-.045))/.075;
   const falloff=Math.max(0,1-dx*dx-dy*dy-dz*dz);if(!falloff||p.z>gh[2]-.015)continue;
   const influences=Array.from({length:4},(_,slot)=>({joint:oldIndices[v*4+slot],weight:oldWeights[v*4+slot]})).filter(x=>x.weight>0);
   const donors=influences.filter(x=>/Spine01|Spine02|Clavicle/.test(joints[x.joint].getName()));const available=donors.reduce((a,x)=>a+x.weight,0),transfer=Math.min(.5*falloff*falloff,available*.75);if(transfer<.002)continue;
   for(const x of donors)x.weight*=1-transfer/available;
   influences.push({joint:entry.index,weight:transfer});influences.sort((a,b)=>b.weight-a.weight||a.joint-b.joint);
   const lost=influences.slice(4).reduce((a,x)=>a+x.weight,0);if(lost>.01)continue;const keep=influences.slice(0,4),sum=keep.reduce((a,x)=>a+x.weight,0);
   for(let slot=0;slot<4;slot++){newIndices[v*4+slot]=keep[slot]?.joint??0;newWeights[v*4+slot]=(keep[slot]?.weight??0)/sum;}
   if(keep.some(x=>x.joint===entry.index)){entry.patchVertices++;entry.maxWeight=Math.max(entry.maxWeight,transfer/sum);entry.maxPrunedWeight=Math.max(entry.maxPrunedWeight,lost);}
  }
  ja.setArray(newIndices);wa.setArray(newWeights);
  const oldMatrices=joints.map((n,i)=>new Matrix4().fromArray(n.getWorldMatrix()).multiply(new Matrix4().fromArray(oldIBM,i*16)));
  const newMatrices=skin.listJoints().map((n,i)=>new Matrix4().fromArray(n.getWorldMatrix()).multiply(new Matrix4().fromArray(newIBM,i*16)));
  for(let v=0;v<pa.getCount();v++){
   const point=new Vector3().fromArray(pa.getArray(),v*3),a=new Vector3(),b=new Vector3();
   for(let k=0;k<4;k++){a.addScaledVector(point.clone().applyMatrix4(oldMatrices[oldIndices[v*4+k]]),oldWeights[v*4+k]);b.addScaledVector(point.clone().applyMatrix4(newMatrices[newIndices[v*4+k]]),newWeights[v*4+k]);}
   maxBindDriftM=Math.max(maxBindDriftM,a.distanceTo(b));
  }
 }
 for(const animation of root.listAnimations()){
  for(const channel of animation.listChannels())for(const entry of Object.values(sides))if(channel.getTargetNode()===entry.arm&&channel.getTargetPath()==='translation'){
   const sampler=channel.getSampler(),output=sampler.getOutput().clone(),values=output.getArray().slice();assert.notEqual(sampler.getInterpolation(),'CUBICSPLINE','Cubic tangents need a distinct migration');
   for(let i=0;i<values.length;i++)values[i]-=entry.local[i%3];output.setArray(values);sampler.setOutput(output);
  }
  const duration=Math.max(...animation.listSamplers().map(s=>Math.max(...s.getInput().getArray())));
  for(const entry of Object.values(sides))for(const [path,value,type] of [['translation',entry.local,'VEC3'],['rotation',[0,0,0,1],'VEC4'],['scale',[1,1,1],'VEC3']]){
   const input=doc.createAccessor('',buffer).setType('SCALAR').setArray(new Float32Array([0,duration]));
   const output=doc.createAccessor('',buffer).setType(type).setArray(new Float32Array([...value,...value]));
   const sampler=doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(entry.scapula).setTargetPath(path).setSampler(sampler));
  }
 }
 assert.ok(maxBindDriftM<2e-6,`Bind pose drift ${maxBindDriftM}`);for(const e of Object.values(sides))assert.ok(e.patchVertices>=10&&e.maxWeight>.1,'Each scapula needs a real posterior skin patch');
 const sidecar={version:manifest.version,calibration:manifest.calibration,variant,sourceSha256:sha(readFileSync(input)),axes:'Source world +X left, +Y superior, +Z anterior; segment controls use captured rest-aligned frames, not ISB clinical Euler angles.',maxBindDriftM,
  sides:Object.fromEntries(Object.entries(sides).map(([side,e])=>[side,{skinIndex:e.index,landmarks:{SC:e.SC,AC:e.AC,GH:e.GH},scapulaLocalPosition:e.local,legacyUpperArmPosition:e.originalArmPosition,patchVertices:e.patchVertices,maxWeight:e.maxWeight,maxPrunedWeight:e.maxPrunedWeight}]))};
 root.setExtras({...root.getExtras(),shoulderRig:sidecar});await io.write(output,doc);const decoded=await io.read(output),after=snapshotRuntimeModel(decoded);
 for(let i=0;i<before.primitives.length;i++){const a=before.primitives[i],b=after.primitives[i];assert.equal(a.triangleListSha256,b.triangleListSha256);for(const [key,value] of Object.entries(a.semantics))if(!['JOINTS_0','WEIGHTS_0'].includes(key))assert.equal(value,b.semantics[key],key);}
 manifest.variants[variant]={...sidecar,assetSha256:sha(readFileSync(output)),snapshot:after};console.log(variant,JSON.stringify({maxBindDriftM,sides:sidecar.sides}));
}
writeFileSync('models/shoulder-v2.manifest.json',JSON.stringify(manifest,null,2)+'\n');

writeFileSync('src/anatomy/shoulderRigAssets.ts', '// Generated by scripts/build-shoulder-v2-models.mjs.\nexport const SHOULDER_RIG_ASSET_HASHES = '+JSON.stringify(Object.fromEntries(Object.entries(manifest.variants).map(([key,value])=>[key,value.assetSha256])))+' as const;\n');
