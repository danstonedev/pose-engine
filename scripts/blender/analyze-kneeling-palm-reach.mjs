/** Static reach interval diagnostic for the measured Blender kneeling proposal. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) throw new Error('Usage: node analyze-kneeling-palm-reach.mjs proposal.json fresh-output.json');
const input = path.resolve(inputArg), output = path.resolve(outputArg);
if (fs.existsSync(output)) throw new Error('Preserve earlier evidence; choose a fresh output filename');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const bytes = fs.readFileSync(input), data = JSON.parse(bytes);
const report = {
  version: 1,
  source: { path: input, sha256: digest(bytes), blenderVersion: data.blenderVersion },
  scriptSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
  scope: 'Static setup/peak geometric feasibility only. Keep every shoulder position, segment length, palm width, exact hand orientation and skin-derived wrist height from the Blender proposal. Intersect both arms’ reach spheres for one fixed longitudinal palm translation. No full trajectory, joint-cone, patient, clinical or native acceptance.',
  coordinates: 'Engine X lateral, Y vertical, Z forward; metres. Positive offset moves both fixed targets forward.',
  boundaryCaution: 'The maximum forward endpoint puts a setup arm at exactly full geometric extension with zero reach margin. This is a diagnostic bound, not a recommended runtime target.',
  cases: [],
};
for (const variant of ['male', 'female', 'neutral']) {
  const rows = data.cases.filter(row => row.id.startsWith(variant));
  if (rows.length !== 2 || rows.some(row => row.arms.length !== 2)) throw new Error('Expected bilateral setup and peak: ' + variant);
  const intervals = rows.flatMap(row => row.arms.map(arm => {
    const [sx, sy, sz] = arm.shoulderEngineM, [tx, ty, tz] = arm.palmOwnerTargetEngineM;
    const maximumReachM = arm.upperArmLengthM + arm.forearmLengthM;
    const minimumReachM = Math.abs(arm.upperArmLengthM - arm.forearmLengthM);
    const perpendicularSq = (tx - sx) ** 2 + (ty - sy) ** 2;
    if (perpendicularSq >= maximumReachM ** 2 || perpendicularSq <= minimumReachM ** 2) {
      throw new Error('This diagnostic assumes a nonempty continuous reach interval away from the inner reach sphere');
    }
    const zSpan = Math.sqrt(maximumReachM ** 2 - perpendicularSq);
    return { phase: row.id, side: arm.side, minimumReachM, maximumReachM,
      minOffsetM: sz - zSpan - tz, maxOffsetM: sz + zSpan - tz };
  }));
  const minOffsetM = Math.max(...intervals.map(interval => interval.minOffsetM));
  const maxOffsetM = Math.min(...intervals.map(interval => interval.maxOffsetM));
  const posesAtMaximum = rows.flatMap(row => row.arms.map(arm => {
    const [sx, sy, sz] = arm.shoulderEngineM, [tx, ty, tz] = arm.palmOwnerTargetEngineM;
    const squaredDistance = (tx - sx) ** 2 + (ty - sy) ** 2 + (tz + maxOffsetM - sz) ** 2;
    const cosine = (squaredDistance - arm.upperArmLengthM ** 2 - arm.forearmLengthM ** 2)
      / (2 * arm.upperArmLengthM * arm.forearmLengthM);
    return { phase: row.id, side: arm.side,
      currentElbowFlexionDeg: arm.geometricElbowFlexionDeg,
      maxForwardElbowFlexionDeg: Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI,
      targetEngineM: [tx, ty, tz + maxOffsetM] };
  }));
  report.cases.push({ variant, commonInterval: { minOffsetM, maxOffsetM }, intervals,
    limitingContexts: intervals.filter(interval => interval.maxOffsetM === maxOffsetM), posesAtMaximum });
}
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, cases: report.cases.map(row => ({ variant: row.variant,
  maxForwardM: row.commonInterval.maxOffsetM,
  peakFlexionDeg: row.posesAtMaximum.filter(pose => pose.phase.endsWith('peak')).map(pose => pose.maxForwardElbowFlexionDeg) })) }));
