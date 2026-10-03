/** Retain selected source facial deltas without changing runtime topology/atlas/skin.
 * node scripts/extract-pain-face.mjs <source-asset-folder>
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRuntimeModelIO } from './runtime-model-snapshot.mjs';
const io = await createRuntimeModelIO();
const names = ['Brow_Drop_L','Brow_Drop_R','Brow_Raise_Inner_L','Brow_Raise_Inner_R','Eye_Squint_L','Eye_Squint_R','Eye_Blink_L','Eye_Blink_R','Nose_Sneer_L','Nose_Sneer_R','Mouth_Press_L','Mouth_Press_R','Jaw_Open','V_Lip_Open'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = accessor => Buffer.from(accessor.getArray().buffer, accessor.getArray().byteOffset, accessor.getArray().byteLength);
const fingerprint = array => { let h=2166136261; for (const value of new Uint8Array(array.buffer,array.byteOffset,array.byteLength)) h=Math.imul(h^value,16777619); return h>>>0; };
const out = resolve('src/assets/pain-face'); mkdirSync(out, {recursive:true});
for (const variant of ['male','female']) {
  const sourcePath = resolve(process.argv[2], `painmap3D_${variant}.glb`);
  const runtimePath = resolve(`models/painmap3D_${variant}.runtime.glb`);
  const source = (await io.read(sourcePath)).getRoot().listMeshes().find(m=>m.getName()==='CC_Base_Body');
  const runtime = (await io.read(runtimePath)).getRoot().listMeshes()[0];
  const targetNames = source.getExtras().targetNames;
  const primitives = runtime.listPrimitives().map((primitive, index) => {
    const original = source.listPrimitives()[index];
    for (const attribute of ['POSITION','NORMAL','TEXCOORD_0','JOINTS_0','WEIGHTS_0']) {
      if (!bytes(primitive.getAttribute(attribute)).equals(bytes(original.getAttribute(attribute)))) throw Error(`${variant} ${index} ${attribute} differs; retarget explicitly`);
    }
    const position = primitive.getAttribute('POSITION');
    const targets = names.map(name => {
      const target = original.listTargets()[targetNames.indexOf(name)];
      if (!target) throw Error(`Missing ${name}`);
      const p = target.getAttribute('POSITION').getArray();
      const values = [];
      for (let v=0;v<position.getCount();v++) {
        const delta = [...p.slice(v*3,v*3+3)];
        if (delta.some(x=>x!==0)) values.push([v,...delta]);
      }
      return {name, values};
    });
    return {count:position.getCount(), positionSha256:sha(bytes(position)), fingerprint:fingerprint(position.getArray()), targets};
  });
  const data = {version:1,variant,sourceSha256:sha(readFileSync(sourcePath)),runtimeSha256:sha(readFileSync(runtimePath)),policy:'Unmodified source position deltas; normals recomputed from deformed triangles. Runtime position/normal/UV/joints/weights verified byte-identical before extraction.',primitives};
  writeFileSync(resolve(out, `${variant}.json`), JSON.stringify(data));
  console.log(variant, primitives.map(p=>p.targets.reduce((n,t)=>n+t.values.length,0)));
}
