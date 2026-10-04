import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';

const [movement, destination, side = 'R'] = process.argv.slice(2);
if (!destination || !movement || !BODY_ASSESSMENT_MOTIONS[movement] || !['L', 'R'].includes(side)) {
  throw new Error('Usage: export-assessment-json.ts <assessment-id> <fresh.json> [L|R]');
}
writeFileSync(resolve(destination), JSON.stringify(BODY_ASSESSMENT_MOTIONS[movement]!(side as 'L' | 'R'), null, 2) + '\n', { flag: 'wx' });
