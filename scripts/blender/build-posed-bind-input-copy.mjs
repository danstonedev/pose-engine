import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const originalPath = new URL('../../src/services/posedGeometry.ts', import.meta.url);
const original = readFileSync(originalPath, 'utf8');
let copy = original.replace("from './debug'", "from '../../src/services/debug'");
copy = copy.replace('  let measurement = 0;', `  let measurement = 0;
  // OFFLINE candidate: one immutable bind-input snapshot per authoritative
  // attribute revision. Posed bone matrices still refresh each measurement.
  const inputs = new WeakMap<THREE.SkinnedMesh, { key: string; checkedAt: number; vertices: Map<number, number[]> }>();
  const ids = new WeakMap<object, number>(); let nextId = 0;
  const id = (object: object) => { let value = ids.get(object); if (value === undefined) { value = nextId++; ids.set(object, value); } return value; };
  const inputKey = (mesh: THREE.SkinnedMesh): string | null => {
    const attribute = (value: SkinAttribute | undefined): unknown => {
      if (!value) return null;
      const interleaved = value instanceof THREE.InterleavedBufferAttribute;
      const prototype = interleaved ? THREE.InterleavedBufferAttribute.prototype : THREE.BufferAttribute.prototype;
      for (const key of ['getX', 'getY', 'getZ', 'getW'] as const) if (value[key] !== prototype[key]) throw new Error('custom-attribute');
      const data = interleaved ? value.data : value;
      return [id(value), id(data.array), data.version, value.count, value.itemSize, value.normalized,
        interleaved ? [value.offset, data.stride] : null];
    };
    try {
      return JSON.stringify([id(mesh.geometry), mesh.bindMatrix.elements,
        attribute(mesh.geometry.getAttribute('position')), attribute(mesh.geometry.getAttribute('skinIndex')),
        attribute(mesh.geometry.getAttribute('skinWeight')), mesh.geometry.morphTargetsRelative,
        mesh.morphTargetInfluences, mesh.geometry.morphAttributes.position?.map(attribute)]);
    } catch { return null; }
  };`);
const start = copy.indexOf("      // Mesh's implementation includes");
const end = copy.indexOf('      target.set(0, 0, 0);', start);
if (start < 0 || end < start) throw Error('copy patch not found');
const originalRead = copy.slice(start, end);
copy = copy.slice(0, start) + `      let prepared = inputs.get(mesh);
      if (!prepared || prepared.checkedAt !== measurement) {
        const key = inputKey(mesh);
        if (key === null) prepared = undefined;
        else if (!prepared || prepared.key !== key) {
          prepared = { key, checkedAt: measurement, vertices: new Map() }; inputs.set(mesh, prepared);
        } else prepared.checkedAt = measurement;
      }
      const saved = prepared?.vertices.get(index);
      if (saved) {
        base.fromArray(saved); indices.fromArray(saved, 3); weights.fromArray(saved, 7);
      } else {
${originalRead}
        prepared?.vertices.set(index, [...base.toArray(), ...indices.toArray(), ...weights.toArray()]);
      }
` + copy.slice(end);
const target = new URL('./captured-posedGeometry-bind-input.ts', import.meta.url);
writeFileSync(target, copy, { flag: 'wx' });
const hash = value => createHash('sha256').update(value).digest('hex');
writeFileSync(new URL('../../../../remaining-batches/pressup-bind-input-copy-1.json', import.meta.url), JSON.stringify({
  createdAtUtc: new Date().toISOString(), original: originalPath.href, originalSha256: hash(original),
  candidate: target.href, candidateSha256: hash(copy),
  scope: 'Offline only. Same CPU skin arithmetic and current bone palette. Cached standard vertex bind inputs invalidated by geometry, attributes, versions, arrays, morph inputs, and bind matrix. Existing per-measurement immutability assumption remains; unversioned typed-array mutation not covered and must be considered before promotion.'
}, null, 2) + '\n', { flag: 'wx' });
