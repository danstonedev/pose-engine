/** Actual-rig flexion support probe. Changes only in-memory authoring candidates. */
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {BODY_VARIANTS} from '../../src/anatomy/bodyVariants';
import {applyAnatomicPose} from '../../src/services/anatomicPose';
import {BODY_ASSESSMENT_MOTIONS} from '../../src/services/assessmentBodyMotions';
import {captureJointAngleRestReference} from '../../src/services/jointAngles';
import {applyCustomPose, buildBoneByPoseKey, serializeCustomPose} from '../../src/services/poseRig';
import {resolveComposedMotion} from '../../src/services/motionSequence';
import {sampleComposedMotion} from '../../src/services/motionRecording';
import {createStageTwistOverlay} from '../../src/services/stageTwistOverlay';
import {setRomClampEnabled} from '../../src/services/poseRomClamp';

const output=process.argv[2];if(!output)throw Error('Fresh output path required');
setRomClampEnabled(false);
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const report:any={scope:'Baseline and isolated root-pitch candidates; actual-rig coordinates and full lower-limb skin at world zero. No runtime source changes, native/clinical approval or optimized thresholds.',
  source:sha(readFileSync(new URL('../../src/services/assessmentBodyMotions.ts',import.meta.url))),cases:[]};
for(const variant of ['male','female','neutral'] as const){
  const bytes=readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`,import.meta.url));
  const root=(await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene;
  const cfg=BODY_VARIANTS[variant];root.scale.setScalar(cfg.pose.rootScale);applyAnatomicPose(root,cfg);root.updateMatrixWorld(true);
  const skins:THREE.SkinnedMesh[]=[];root.traverse(o=>{if((o as THREE.SkinnedMesh).isSkinnedMesh)skins.push(o as THREE.SkinnedMesh);});
  const skin=skins[0],skeleton=skin.skeleton,bones=buildBoneByPoseKey(skeleton,cfg);
  const rest=captureJointAngleRestReference(skeleton,cfg),baselinePose=serializeCustomPose(skeleton,cfg,variant);
  const twist=createStageTwistOverlay();twist.reset(skeleton,cfg);
  const restRoot={p:root.position.clone(),q:root.quaternion.clone()};
  const memberships=skins.map(s=>{
    const index=s.geometry.getAttribute('skinIndex'),weight=s.geometry.getAttribute('skinWeight');
    return Array.from({length:index.count},(_,i)=>{
      let best=0;for(let j=1;j<4;j++)if(weight.getComponent(i,j)>weight.getComponent(i,best))best=j;
      const name=s.skeleton.bones[index.getComponent(i,best)].name;
      const side=name.includes('_L_')?'L':name.includes('_R_')?'R':'center';
      const region=/Toe/.test(name)?'toes':/Foot/.test(name)?'foot':/Calf/.test(name)?'calf':/Thigh/.test(name)?'thigh':/Hand|Finger|Thumb|Index|Mid|Ring|Pinky/.test(name)?'hand':/Forearm/.test(name)?'forearm':/Head|Neck/.test(name)?'head':'other';
      return `${side} ${region}`;
    });
  });
  for(const pitch of [70,90,110]){
    root.position.copy(restRoot.p);root.quaternion.copy(restRoot.q);applyCustomPose(skeleton,cfg,baselinePose);root.updateMatrixWorld(true);
    const authored=BODY_ASSESSMENT_MOTIONS['flexion-clearing']('R');
    authored.keyframes[1].root={orient:{pitchDeg:pitch}};
    const recording=sampleComposedMotion(resolveComposedMotion(authored,cfg),{variantCfg:cfg,rest,baselinePose,skeletonHarness:{root,skinned:skin},frameTimesMs:[0,1000,2600,4400,5800]});
    const frames=recording.frames.map(frame=>{
      root.position.fromArray(frame.root.translateM);root.quaternion.fromArray(frame.root.orientQuat);applyCustomPose(skeleton,cfg,frame.pose);
      return twist.sampleWithTwist(()=>{
        root.updateMatrixWorld(true);const minima:Record<string,number>={};
        skins.forEach((s,k)=>{s.skeleton.update();for(let i=0;i<memberships[k].length;i++){
          const p=s.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(s.matrixWorld),region=memberships[k][i];
          minima[region]=Math.min(minima[region]??Infinity,p.y);
        }});
        const positions=Object.fromEntries([...bones].map(([key,b])=>[key,b.getWorldPosition(new THREE.Vector3()).toArray()]));
        return {tMs:frame.tMs,root:frame.root,angles:frame.angles,minima,positions,
          boneTransforms:Object.fromEntries([...bones].map(([key,b])=>[key,{name:b.name,localQuaternion:b.quaternion.toArray(),worldQuaternion:b.getWorldQuaternion(new THREE.Quaternion()).toArray(),parentWorldQuaternion:b.parent!.getWorldQuaternion(new THREE.Quaternion()).toArray()}]))};
      });
    });
    report.cases.push({variant,pitch,assetSha256:sha(bytes),restReference:rest,frames});
    console.log(JSON.stringify({variant,pitch,frames:frames.map(f=>({tMs:f.tMs,hip:f.positions.Hips,foot:f.positions.L_Foot,toes:f.minima['L toes'],head:f.minima['center head']}))}));
  }
}
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
