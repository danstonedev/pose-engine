import { defineConfig } from 'vitest/config';
// Diagnostic only: no runtime file is modified. Removes just the new SQUAD
// exact-endpoint/constant-channel branch to identify legacy release sensitivity.
export default defineConfig({
  plugins:[{name:'legacy-squad-counterfactual',enforce:'pre',transform(code,id){
    if(!id.endsWith('/src/services/motionTrajectory.ts'))return;
    const start=code.indexOf('  // Imported Float32 quaternions');
    const end=code.indexOf('  _qa.set(q0[0]',start);
    if(start<0||end<0)throw Error('SQUAD counterfactual source drift');
    const block=code.slice(start,end),part=process.env.LEGACY_SQUAD_PART;
    if(part==='constant')return code.slice(0,start)+block.replace(/  if \(q0\.every[\s\S]*?\n  }\n/,'')+code.slice(end);
    if(part==='endpoint')return code.slice(0,start)+block.replace(/  if \(t === [01]\) return \[\.\.\.q[01]\];\n/g,'')+code.slice(end);
    return code.slice(0,start)+code.slice(end);
  }}],
  test:{globals:true,environment:'node',include:['src/**/*.test.ts'],maxWorkers:1,fileParallelism:false},
});
