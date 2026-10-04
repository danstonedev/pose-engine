import{readFileSync,writeFileSync}from'node:fs';import{resolve}from'node:path';import{createHash}from'node:crypto';
const root=process.cwd(),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),changes=[];
const modulePath='src/services/stageMotionLiveliness.ts',stagePath='src/ExamStage3D.svelte';
const roots=[resolve(root,'../.review.local/engine-release-review'),resolve(root,'../../simlab/pose-engine')];
for(const targetRoot of roots)for(const file of[modulePath,stagePath]){
 const target=resolve(targetRoot,file),before=readFileSync(target),sha=hash(before);
 const expected=file===modulePath?'f57f0ce113cf7e2353d6d8359bac533e1cde1ecbea94206d95b56fd21f91f36d':targetRoot.includes('simlab')?'2ce95cbdd70e1f13e40046a0ce3604c5aef69929d0f0690eb50765d16bad02e3':'d8ecd2b0b9e88cdc2f9002622380dd1c059962693400f6a32288b9f6818db81d';
 if(sha!==expected)throw Error('Concurrent target edit: '+target);
 let after=readFileSync(resolve(root,file));
 if(file===stagePath&&targetRoot.includes('simlab')){
  let text=before.toString(),newline=text.includes('\r\n')?'\r\n':'\n';text=text.replaceAll('\r\n','\n');
  const anchor='      function buildFrameNow(tMs: number): RecordedFrame | null {\n        if (!skinnedRef || !variantCfgRef || !restRef || !modelRoot) return null;';
  const end='          if (eyeRestore) eyeRestore();\n        }\n      }';
  if(text.split(anchor).length!==2||text.split(end).length!==2)throw Error('Expected capture patch context changed');
  text=text.replace(anchor,anchor+'\n        // Public capture and start/stop snapshots can run after the render-time\n        // motion overlay, unlike the in-loop tap. Sample the same clean pose.\n        return motionLive.sampleClean(motionCapBones, modelRoot, () => {').replace(end,'          if (eyeRestore) eyeRestore();\n        }\n        });\n      }');
  after=Buffer.from(newline==='\r\n'?text.replaceAll('\n','\r\n'):text);
 }
 writeFileSync(target,after);changes.push({target,before:sha,after:hash(after)});
}
const test='src/__tests__/motionLivelinessCapture.test.ts';writeFileSync(resolve(roots[0],test),readFileSync(resolve(root,test)));
writeFileSync(resolve(root,'../../remaining-batches/public-capture-liveliness-sync-1.json'),JSON.stringify({createdAt:new Date().toISOString(),changes},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(changes));
