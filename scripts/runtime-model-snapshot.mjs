/**
 * Shared snapshot helpers for the runtime-model compress/verify scripts.
 *
 * The snapshot captures everything body-chart's paint/metrics ecosystem keys
 * off: node/mesh names, skin joint counts, extensionsUsed, and — because the
 * compression contract is LOSSLESS — SHA-256 hashes of every attribute
 * accessor's bytes plus a canonical triangle-list hash per primitive.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { createHash } from 'node:crypto';

export async function createRuntimeModelIO() {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Canonical hash of the triangle list: per face, the SORTED vertex triple, in
 * face order. Insensitive to the intra-triangle rotation the meshopt index
 * codec applies (which preserves triangle identity and winding); sensitive to
 * any face reorder, drop, or vertex change — the properties the faceIndex-keyed
 * triangle-region atlas depends on.
 */
function triangleListHash(indexArray) {
  const canonical = new Uint32Array(indexArray.length);
  for (let f = 0; f < indexArray.length; f += 3) {
    const t = [indexArray[f], indexArray[f + 1], indexArray[f + 2]].sort((x, y) => x - y);
    canonical[f] = t[0];
    canonical[f + 1] = t[1];
    canonical[f + 2] = t[2];
  }
  return sha256(Buffer.from(canonical.buffer));
}

/** Structural + byte-level snapshot the runtime consumers depend on. */
export function snapshotRuntimeModel(doc) {
  const root = doc.getRoot();
  const primitives = [];
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const semantics = {};
      for (const sem of prim.listSemantics()) {
        const arr = prim.getAttribute(sem).getArray();
        semantics[sem] = sha256(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
      }
      const idx = prim.getIndices();
      primitives.push({
        mesh: mesh.getName(),
        semantics,
        triangleCount: idx ? idx.getCount() / 3 : null,
        triangleListSha256: idx ? triangleListHash(idx.getArray()) : null,
      });
    }
  }
  return {
    nodeNames: root
      .listNodes()
      .map((n) => n.getName())
      .sort(),
    meshNames: root
      .listMeshes()
      .map((m) => m.getName())
      .sort(),
    skinJointCounts: root.listSkins().map((s) => s.listJoints().length),
    extensionsUsed: root
      .listExtensionsUsed()
      .map((e) => e.extensionName)
      .sort(),
    primitives,
  };
}
