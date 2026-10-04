import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(import.meta.url);
const scope=process.argv[2]??'engine';
if(!['engine','simmove'].includes(scope)) throw Error('Use engine or simmove scope; simLAB reconstructs its live registries with its own runner.');
const cli=resolve(dirname(require.resolve('vitest/package.json')),'vitest.mjs');
for(const args of [[resolve(root,'scripts/catalogue/check.mjs'),scope],[cli,'run','--config',resolve(root,'scripts/catalogue/vitest.config.mjs')]]){
  const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',env:{...process.env,MOVEMENT_CATALOGUE_MODE:'check',MOVEMENT_CATALOGUE_HOST:scope==='simmove'?'simmove':''}});
  if(result.error) throw result.error;
  if(result.status!==0){process.exitCode=result.status??1;break;}
}
