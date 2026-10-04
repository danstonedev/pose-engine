import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const source=readFileSync(new URL('../../src/services/motionTrajectory.ts',import.meta.url),'utf8');
writeFileSync(new URL('./captured-motion-trajectory-exact-1.ts',import.meta.url),source.replaceAll("from '../types'","from '../../src/types'").replaceAll("from './","from '../../src/services/"),{flag:'wx'});
console.log(createHash('sha256').update(source).digest('hex'));
