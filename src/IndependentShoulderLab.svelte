<script lang="ts">
  import {onMount} from 'svelte';
  import type * as THREE from 'three';
  import type {BodyVariantId} from './anatomy/bodyVariants';
  let {base=''}:{base?:string}=$props();
  let host:HTMLDivElement;
  let variant=$state<BodyVariantId>('female'),side=$state<'L'|'R'>('R'),ready=$state(false),weights=$state(false),status=$state('Loading');
  let sc=$state([0,0,0]),ac=$state([0,0,0]),gh=$state([0,0,0]),report=$state(''),saved=$state('');
  let reload=()=>{},apply=()=>{},reset=()=>{},exportPose=()=>{},importPose=()=>{},showWeights=()=>{};
  onMount(()=>{
    let dispose=()=>{},destroyed=false;
    void(async()=>{
      const THREE=await import('three'),{OrbitControls}=await import('three/examples/jsm/controls/OrbitControls.js');
      const {independentShoulderVariant,captureIndependentShoulderReference,applyIndependentShoulderTargets,inspectIndependentShoulder}=await import('./services/independentShoulderRig');
      const {loadVariantModel}=await import('./services/sceneBoot'),{applyAnatomicPose}=await import('./services/anatomicPose');
      const {serializeCustomPose,applyCustomPose}=await import('./services/poseRig');
      if(destroyed)return;
      const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(host.clientWidth,680);host.appendChild(renderer.domElement);
      const scene=new THREE.Scene();scene.background=new THREE.Color('#17212a');const camera=new THREE.PerspectiveCamera(36,host.clientWidth/680,.01,100);camera.position.set(-1.8,1.45,-2.5);
      const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,1.15,0);controls.update();scene.add(new THREE.HemisphereLight(0xffffff,0x657287,2));const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(2,4,-3);scene.add(light);
      const floor=new THREE.GridHelper(3,30,0x496477,0x33414b);scene.add(floor);
      let root:THREE.Object3D|null=null,skin:THREE.SkinnedMesh|null=null,ref:ReturnType<typeof captureIndependentShoulderReference>|null=null,neutral:ReturnType<typeof serializeCustomPose>|null=null,cfg=independentShoulderVariant(variant),closed=false,token=0;
      const materials:THREE.Material[]=[];
      const refresh=()=>{if(!ref)return;report=JSON.stringify(inspectIndependentShoulder(ref,side),null,2);};
      const render=()=>{if(closed)return;renderer.render(scene,camera);};
      showWeights=()=>{root?.traverse(n=>{const sm=n as THREE.SkinnedMesh;if(!sm.isSkinnedMesh)return;const mat=sm.material as THREE.MeshStandardMaterial;mat.vertexColors=weights&&!!sm.geometry.getAttribute('color');mat.needsUpdate=true;});render();};
      reload=()=>{const run=++token;ready=false;status='Loading';void(async()=>{
        const nextCfg=independentShoulderVariant(variant),loaded=await loadVariantModel(nextCfg,base);if(closed||run!==token)return;
        if(root){scene.remove(root);root.traverse(n=>{const mesh=n as THREE.Mesh;if(mesh.geometry)mesh.geometry.dispose();});for(const material of materials)material.dispose();materials.length=0;}root=loaded.root;skin=loaded.skinned;if(!skin)throw new Error('Missing skin');cfg=nextCfg;applyAnatomicPose(root,cfg);root.updateMatrixWorld(true);ref=captureIndependentShoulderReference(skin.skeleton,cfg);neutral=serializeCustomPose(skin.skeleton,cfg,variant);
        root.traverse(n=>{const sm=n as THREE.SkinnedMesh;if(!sm.isSkinnedMesh)return;const material=new THREE.MeshStandardMaterial({color:0xe5ecf0,roughness:.7,metalness:0});for(const old of (Array.isArray(sm.material)?sm.material:[sm.material]))old.dispose();materials.push(material);sm.material=material;
          const ids=sm.geometry.getAttribute('skinIndex'),ws=sm.geometry.getAttribute('skinWeight');if(!ids||!ws)return;const indices=['L','R'].map(s=>sm.skeleton.bones.indexOf(ref!.bones.get(`${s}_Scapula`)!));const colors=new Float32Array(ids.count*3);
          for(let i=0;i<ids.count;i++){let value=0;for(let k=0;k<4;k++)if(indices.includes(ids.getComponent(i,k)))value+=ws.getComponent(i,k);const color=new THREE.Color().setRGB(.18+Math.min(1,value*3)*.82,.3+value*.8,.48-value*.6);color.toArray(colors,i*3);}sm.geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
        });scene.add(root);sc=[0,0,0];ac=[0,0,0];gh=[0,0,0];ready=true;status='Ready';refresh();showWeights();render();
      })().catch(e=>{status=String(e);});};
      const q=(values:number[])=>new THREE.Quaternion().setFromEuler(new THREE.Euler(...values.map(v=>v*Math.PI/180) as [number,number,number],'XYZ')).toArray();
      apply=()=>{if(!ref)return;try{const result=applyIndependentShoulderTargets(ref,side,{SC:q(sc),AC:q(ac),GH:q(gh)});report=JSON.stringify(result,null,2);status='Ready';render();}catch(e){status=String(e);}};
      reset=()=>{if(!skin||!neutral)return;applyCustomPose(skin.skeleton,cfg,neutral);sc=[0,0,0];ac=[0,0,0];gh=[0,0,0];refresh();render();};
      exportPose=()=>{if(skin)saved=JSON.stringify(serializeCustomPose(skin.skeleton,cfg,variant),null,2);};
      importPose=()=>{if(!skin)return;try{const pose=JSON.parse(saved);if(pose.variant!==variant)throw new Error('Choose the saved body model first');applyCustomPose(skin.skeleton,cfg,pose);refresh();render();status='Pose restored';}catch(e){status=String(e);}};
      controls.addEventListener('change',render);const observer=new ResizeObserver(()=>{const w=host.clientWidth;renderer.setSize(w,680);camera.aspect=w/680;camera.updateProjectionMatrix();render();});observer.observe(host);reload();
      dispose=()=>{closed=true;token++;observer.disconnect();controls.dispose();renderer.dispose();for(const m of materials)m.dispose();root?.traverse(n=>{if((n as THREE.Mesh).geometry)(n as THREE.Mesh).geometry.dispose();});renderer.domElement.remove();};
    })().catch(e=>{status=String(e);});
    return()=>{destroyed=true;dispose();};
  });
</script>
<section>
  <h2>Independent shoulder rig</h2>
  <p>Clavicle and scapula controls with posterior skin deformation. Engineering landmark estimates; clinical calibration is pending. ST and HT are measured from the resulting segment chain.</p>
  <div class="toolbar">
    <label>Body <select aria-label="Body" bind:value={variant} onchange={()=>reload()}><option value="female">Female</option><option value="male">Male</option><option value="neutral">Neutral</option></select></label>
    <label>Side <select aria-label="Side" bind:value={side} onchange={()=>reset()}><option value="R">Right</option><option value="L">Left</option></select></label>
    <label><input type="checkbox" bind:checked={weights} onchange={()=>showWeights()}/> Show scapular weights</label>
    <button onclick={()=>reset()} disabled={!ready}>Neutral</button>
    <button onclick={()=>{const sign=side==='R'?-1:1;sc=[0,0,15*sign];ac=[0,0,25*sign];gh=[0,0,80*sign];apply();}} disabled={!ready}>Coordinated elevation</button>
    <button onclick={()=>{sc=[0,0,0];ac=[0,20,0];gh=[0,0,0];apply();}} disabled={!ready}>Scapula rotation</button>
    <span role="status">{status}</span>
  </div>
  <div bind:this={host} class="canvas"></div>
  <p>Angles below are rotations about the captured rest-frame axes in XYZ order, in degrees. They are not clinical goniometry.</p>
  <div class="controls">{#each [{name:'SC: clavicle',values:sc,max:45},{name:'AC: scapula',values:ac,max:70},{name:'GH: upper arm',values:gh,max:150}] as group}<fieldset><legend>{group.name}</legend>{#each ['X','Y','Z'] as axis,i}<label>{axis}<input aria-label={`${group.name} ${axis}`} type="range" min={-group.max} max={group.max} step="1" bind:value={group.values[i]} oninput={()=>apply()}/><output>{group.values[i]}°</output></label>{/each}</fieldset>{/each}</div>
  <details><summary>Measured segment rotations</summary><pre>{report}</pre></details>
  <details><summary>Save or restore a rig pose</summary><button onclick={()=>exportPose()} disabled={!ready}>Capture pose</button><button onclick={()=>importPose()} disabled={!ready||!saved}>Restore pose</button><textarea aria-label="Saved rig pose" bind:value={saved}></textarea></details>
</section>
<style>
 section{font:14px system-ui;color:#dce7ed;background:#17212a;padding:20px;border-radius:12px}h2{margin-top:0}p{max-width:100ch;color:#b8cbd7}.toolbar,.controls{display:flex;gap:16px;flex-wrap:wrap;align-items:center}.canvas{width:100%;height:680px;margin-top:14px}fieldset{border:1px solid #516171;border-radius:6px}fieldset label{display:flex;gap:8px;align-items:center}output{min-width:40px}button,select{font:inherit;padding:6px}details{margin-top:16px}pre{max-height:350px;overflow:auto}textarea{display:block;width:100%;height:140px;margin-top:10px}
</style>
