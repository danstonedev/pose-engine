/** Fit bounded engine commands to Blender-authored reach landmarks.
 * Candidate generator only: production trajectory and all-body checks still apply.
 * vite-node scripts/blender/fit-reach.ts <target.json> <fresh-output.json> [previous-fit.json] [hand-only]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Vector3, type SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS, type BodyVariantId } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../../src/services/poseRig';
import { buildComposedCommandPose } from '../../src/services/movementCommand';
import { shoulderConstraintsForPolicy } from '../../src/services/shoulderRuntime';
import { createArmTorsoContact } from '../../src/services/armTorsoContact';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay';

interface AuthoredReach {
 variant: string;
 side: string;
 baseline: Record<string, [number, number, number]>;
 candidate: Record<string, [number, number, number]>;
}
const input = readFileSync(process.argv[2], 'utf8');
const authored = JSON.parse(input) as AuthoredReach;
if (authored.variant !== 'male' || authored.side !== 'L') throw Error('This initial fitter expects the male-left authoring scene');
const landmarks = ['UpperArm', 'Forearm', 'Hand', 'Mid1', 'Mid3', 'Index1', 'Pinky1'];
const raw = ['Upperarm', 'Forearm', 'Hand', 'Mid1', 'Mid3', 'Index1', 'Pinky1'];
for (const group of [authored.baseline, authored.candidate]) for (const name of raw) {
 const point = group?.[`CC_Base_L_${name}`];
 if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) throw Error(`Missing/invalid landmark ${name}`);
}
const output = process.argv[3];
if (!output || existsSync(output)) throw Error('Provide a fresh output JSON');
const baseline = [-60, 0, 70, 100, -15, -60, 10, 20];
const initial: number[] = process.argv[4] ? JSON.parse(readFileSync(process.argv[4], 'utf8')).best.p : baseline;
if (!Array.isArray(initial) || initial.length !== 8 || !initial.every(Number.isFinite)) throw Error('Invalid previous fit');
const bounds = [[-60, 0], [-30, 70], [-90, 70], [20, 150], [-30, 30], [-90, 90], [-40, 40], [-20, 20]];
const constraints = shoulderConstraintsForPolicy('enforce-proxy');
const t = (motion: string, degrees: number) => ({motion, degrees});
async function loadCase(variant: BodyVariantId, side: 'L' | 'R') {
 const cfg = BODY_VARIANTS[variant];
 const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
 const {scene: root} = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
 root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
 let skin!: SkinnedMesh; root.traverse(o => {if (!skin && (o as SkinnedMesh).isSkinnedMesh) skin = o as SkinnedMesh;});
 const bones = buildBoneByPoseKey(skin.skeleton, cfg), rest = captureJointAngleRestReference(skin.skeleton, cfg);
 const neutral = serializeCustomPose(skin.skeleton, cfg, variant);
 const contact = createArmTorsoContact(root)!;
 const twist = createStageTwistOverlay(); twist.reset(skin.skeleton, cfg);
 const world = (key: string) => bones.get(`${side}_${key}`)!.getWorldPosition(new Vector3());
 function apply(p: number[]) {
  let pose = buildComposedCommandPose(neutral, `${side}_UpperArm`, [t('shoulderFlexion', p[0]), t('shoulderAbduction', p[1]), t('shoulderRotation', p[2])], cfg, neutral, rest, [t('protraction', p[4])], constraints)!;
  pose = buildComposedCommandPose(neutral, `${side}_Forearm`, [t('elbowFlexion', p[3]), t('forearmRotation', p[5])], cfg, pose, rest)!;
  pose = buildComposedCommandPose(neutral, `${side}_Hand`, [t('wristFlexion', p[6]), t('wristDeviation', p[7])], cfg, pose, rest)!;
  applyCustomPose(skin.skeleton, cfg, pose); root.updateMatrixWorld(true);
 }
 apply(baseline);
 const scale = world('UpperArm').distanceTo(world('Forearm')) / new Vector3().fromArray(authored.baseline.CC_Base_L_Upperarm).distanceTo(new Vector3().fromArray(authored.baseline.CC_Base_L_Forearm));
 const targets = landmarks.map((key, i) => {
  const delta=new Vector3().fromArray(authored.candidate[`CC_Base_L_${raw[i]}`]).sub(new Vector3().fromArray(authored.baseline[`CC_Base_L_${raw[i]}`])).multiplyScalar(scale);
  if(side==='R')delta.x=-delta.x;
  return world(key).add(delta);
 });
 return {variant, side, apply, world, landmarks, targets, contact, twist,
  modelSha256: createHash('sha256').update(bytes).digest('hex')};
}
const cases = await Promise.all((['male', 'female', 'neutral'] as const).flatMap(variant=>(['L','R'] as const).map(side=>loadCase(variant,side))));
let evaluations = 0;
function evaluate(p: number[], clearance: boolean) {
 let loss = 0;
 const rows = [];
 for (const c of cases) {
  c.apply(p);
  const weights = [.2, .2, 6, 2, 2, 1, 1];
  const errors = c.landmarks.map((key, i) => c.world(key).distanceTo(c.targets[i]));
  let canonical = 0, rendered = 0;
  if (clearance) {
   c.contact.refresh();
   canonical = c.contact.inspect(c.side).penetrationM;
   rendered = c.twist.sampleWithTwist(() => {c.contact.refresh(); return c.contact.inspect(c.side).penetrationM;});
  }
  loss += errors.reduce((sum, error, i) => sum + weights[i] * error ** 2, 0)
      + 2000 * Math.max(canonical, rendered) ** 2;
  rows.push({variant: c.variant, side: c.side, wristM: c.world('Hand').toArray(), middleJointM: c.world('Mid3').toArray(), landmarkErrorsM: errors, canonicalPenetrationM: canonical, renderedPenetrationM: rendered});
 }
 evaluations++;
 return {p: [...p], loss, rows};
}
let best = evaluate(initial, true);
console.log('BASELINE', JSON.stringify(best));
let overall = best;
let seed = 18317;
const random = () => {seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296;};
for (let trial = 0; trial < (process.argv[4] ? 1 : 12); trial++) {
 if (trial) best = evaluate(bounds.map(([a,b]) => a + random() * (b-a)), true);
for (const step of [20, 10, 5, 2, 1, .5]) {
 for (let pass = 0; pass < 10; pass++) {
  let improved = false;
  for (let i = process.argv[5]==='hand-only'?5:0; i < baseline.length; i++) for (const sign of [-1, 1]) {
   const p = [...best.p]; p[i] = Math.max(bounds[i][0], Math.min(bounds[i][1], p[i] + sign * step));
   if (p[i] === best.p[i]) continue;
   const result = evaluate(p, true);
   if (result.loss < best.loss) {best = result; improved = true;}
  }
  if (!improved) break;
 }
}
 if (best.loss < overall.loss) overall = best;
 console.log('TRIAL', trial, JSON.stringify(best));
}
best = overall;
writeFileSync(output, JSON.stringify({
 authoredSource: process.argv[2], startingFit: process.argv[4], authoredSha256: createHash('sha256').update(input).digest('hex'),
 modelSha256: Object.fromEntries(cases.map(c => [c.variant, c.modelSha256])),
 method: 'Deterministic landmark fit, limb-length-scaled displacement on three bodies and both sides; neutral-initialized, pose-refreshed canonical and rendered torso envelope penalty at the held pose. Wrist authoring band is narrower than registry ROM. This does not validate a trajectory or an anatomical endpoint.',
 clinicalEndpointValidated: false, bounds, evaluations, best,
}, null, 2), {flag: 'wx'});
