import * as THREE from 'three';
import {
  bodyChartDebugLog,
  isBodyChartDebugEnabled,
  shouldSampleBodyChartDebug,
} from './debug';

type SkinAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

export interface CreatePosedWorldGeometryOptions {
  requiredAttributes?: string[];
  nonIndexed?: boolean;
  debugLabel?: string;
}

export function createPosedWorldGeometry(
  mesh: THREE.Mesh,
  options: CreatePosedWorldGeometryOptions = {},
): THREE.BufferGeometry | null {
  mesh.updateMatrixWorld(true);

  const debugLabel = options.debugLabel ?? getMeshDebugLabel(mesh);

  const source = mesh.geometry;
  if (!source) {
    bodyChartDebugLog('posedGeometry missing source geometry', { mesh: debugLabel });
    return null;
  }

  const requiredAttributes = options.requiredAttributes ?? ['position'];
  const missingAttributes: string[] = [];
  for (const attributeName of requiredAttributes) {
    if (!source.getAttribute(attributeName)) missingAttributes.push(attributeName);
  }

  if (missingAttributes.length > 0) {
    bodyChartDebugLog('posedGeometry missing required attributes', {
      mesh: debugLabel,
      missingAttributes,
      availableAttributes: Object.keys(source.attributes),
    });
    return null;
  }

  let geometry = source.clone();

  if (isSkinnedMesh(mesh)) {
    if (shouldSampleBodyChartDebug(`posedGeometry:${debugLabel}:source`, 2)) {
      bodyChartDebugLog('posedGeometry skinned source summary', summarizeSkinnedMesh(mesh));
    }
    bakeSkinnedGeometryInPlace(mesh, geometry, debugLabel);
  }

  if (options.nonIndexed && geometry.index) {
    const nonIndexedGeometry = geometry.toNonIndexed() ?? geometry.clone();
    if (nonIndexedGeometry !== geometry) geometry.dispose();
    geometry = nonIndexedGeometry;
  }

  geometry.applyMatrix4(mesh.matrixWorld);

  if (shouldSampleBodyChartDebug(`posedGeometry:${debugLabel}:prepared`, 2)) {
    bodyChartDebugLog('posedGeometry prepared geometry summary', {
      mesh: debugLabel,
      indexedSource: Boolean(source.index),
      indexedPrepared: Boolean(geometry.index),
      positionCount: geometry.getAttribute('position')?.count ?? 0,
      uvCount: geometry.getAttribute('uv')?.count ?? 0,
      attributeNames: Object.keys(geometry.attributes),
      appliedMatrixWorld: true,
      nonIndexedRequested: options.nonIndexed ?? false,
    });
  }

  return geometry;
}

export function bakeSkinnedGeometryInPlace(
  mesh: THREE.SkinnedMesh,
  geometry: THREE.BufferGeometry,
  debugLabel = getMeshDebugLabel(mesh),
): boolean {
  const position = geometry.getAttribute('position');
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  const skeleton = mesh.skeleton;

  if (!position || !skinIndex || !skinWeight || !skeleton?.bones?.length) {
    bodyChartDebugLog('posedGeometry skinned bake skipped', {
      mesh: debugLabel,
      reason: 'missing-position-skin-or-bones',
      hasPosition: Boolean(position),
      hasSkinIndex: Boolean(skinIndex),
      hasSkinWeight: Boolean(skinWeight),
      boneCount: skeleton?.bones?.length ?? 0,
    });
    return false;
  }

  if (position.count !== skinIndex.count || position.count !== skinWeight.count) {
    bodyChartDebugLog('posedGeometry skinned bake skipped', {
      mesh: debugLabel,
      reason: 'attribute-count-mismatch',
      positionCount: position.count,
      skinIndexCount: skinIndex.count,
      skinWeightCount: skinWeight.count,
    });
    return false;
  }

  if (isBodyChartDebugEnabled()) {
    return bakeSkinnedGeometryDiagnostic(mesh, geometry, debugLabel, position, skinIndex, skinWeight);
  }

  return bakeSkinnedGeometryFast(mesh, geometry, position, skinIndex, skinWeight);
}

/**
 * Fast-path skin bake: precomputes one combined affine matrix per bone (folding
 * bindMatrixInverse · boneWorld · boneInverse · bindMatrix), then walks vertices
 * with inline typed-array reads and inline matrix-vector math. Avoids the
 * per-vertex Vector3, BufferAttribute getter, and matrix-matrix multiply that
 * make `THREE.SkinnedMesh.applyBoneTransform` slow at scale.
 */
function bakeSkinnedGeometryFast(
  mesh: THREE.SkinnedMesh,
  geometry: THREE.BufferGeometry,
  position: SkinAttribute,
  skinIndex: SkinAttribute,
  skinWeight: SkinAttribute,
): boolean {
  const skeleton = mesh.skeleton;
  skeleton.update();

  const bones = skeleton.bones;
  const boneInverses = skeleton.boneInverses;
  const boneCount = bones.length;

  // combined[b] = bindMatrixInverse · bones[b].matrixWorld · boneInverses[b] · bindMatrix
  // Stored flat (16 floats per bone, column-major like THREE.Matrix4.elements).
  const combined = new Float32Array(boneCount * 16);
  const tmpA = new THREE.Matrix4();
  const tmpB = new THREE.Matrix4();
  for (let b = 0; b < boneCount; b += 1) {
    tmpA.multiplyMatrices(bones[b].matrixWorld, boneInverses[b]);
    tmpB.multiplyMatrices(tmpA, mesh.bindMatrix);
    tmpA.multiplyMatrices(mesh.bindMatrixInverse, tmpB);
    combined.set(tmpA.elements, b * 16);
  }

  const vertexCount = position.count;
  const baked = new Float32Array(vertexCount * 3);

  // Direct typed-array access when available (BufferAttribute, itemSize matches).
  // InterleavedBufferAttribute / mismatched stride falls back to getX/getY/getZ/getW.
  const posDirect = getDirectVec3Reader(position);
  const idxDirect = getDirectVec4Reader(skinIndex);
  const wtDirect = getDirectVec4Reader(skinWeight);

  for (let i = 0; i < vertexCount; i += 1) {
    let px: number;
    let py: number;
    let pz: number;
    if (posDirect) {
      const o = i * posDirect.stride;
      px = posDirect.array[o];
      py = posDirect.array[o + 1];
      pz = posDirect.array[o + 2];
    } else {
      px = position.getX(i);
      py = position.getY(i);
      pz = position.getZ(i);
    }

    let w0: number;
    let w1: number;
    let w2: number;
    let w3: number;
    if (wtDirect) {
      const o = i * wtDirect.stride;
      w0 = wtDirect.array[o];
      w1 = wtDirect.array[o + 1];
      w2 = wtDirect.array[o + 2];
      w3 = wtDirect.array[o + 3];
    } else {
      w0 = skinWeight.getX(i);
      w1 = skinWeight.getY(i);
      w2 = skinWeight.getZ(i);
      w3 = skinWeight.getW(i);
    }

    let b0: number;
    let b1: number;
    let b2: number;
    let b3: number;
    if (idxDirect) {
      const o = i * idxDirect.stride;
      b0 = idxDirect.array[o];
      b1 = idxDirect.array[o + 1];
      b2 = idxDirect.array[o + 2];
      b3 = idxDirect.array[o + 3];
    } else {
      b0 = skinIndex.getX(i);
      b1 = skinIndex.getY(i);
      b2 = skinIndex.getZ(i);
      b3 = skinIndex.getW(i);
    }

    let ox = 0;
    let oy = 0;
    let oz = 0;
    let totalWeight = 0;

    if (w0 > 0 && b0 >= 0 && b0 < boneCount) {
      const m = b0 * 16;
      ox += (combined[m] * px + combined[m + 4] * py + combined[m + 8] * pz + combined[m + 12]) * w0;
      oy +=
        (combined[m + 1] * px + combined[m + 5] * py + combined[m + 9] * pz + combined[m + 13]) * w0;
      oz +=
        (combined[m + 2] * px + combined[m + 6] * py + combined[m + 10] * pz + combined[m + 14]) * w0;
      totalWeight += w0;
    }
    if (w1 > 0 && b1 >= 0 && b1 < boneCount) {
      const m = b1 * 16;
      ox += (combined[m] * px + combined[m + 4] * py + combined[m + 8] * pz + combined[m + 12]) * w1;
      oy +=
        (combined[m + 1] * px + combined[m + 5] * py + combined[m + 9] * pz + combined[m + 13]) * w1;
      oz +=
        (combined[m + 2] * px + combined[m + 6] * py + combined[m + 10] * pz + combined[m + 14]) * w1;
      totalWeight += w1;
    }
    if (w2 > 0 && b2 >= 0 && b2 < boneCount) {
      const m = b2 * 16;
      ox += (combined[m] * px + combined[m + 4] * py + combined[m + 8] * pz + combined[m + 12]) * w2;
      oy +=
        (combined[m + 1] * px + combined[m + 5] * py + combined[m + 9] * pz + combined[m + 13]) * w2;
      oz +=
        (combined[m + 2] * px + combined[m + 6] * py + combined[m + 10] * pz + combined[m + 14]) * w2;
      totalWeight += w2;
    }
    if (w3 > 0 && b3 >= 0 && b3 < boneCount) {
      const m = b3 * 16;
      ox += (combined[m] * px + combined[m + 4] * py + combined[m + 8] * pz + combined[m + 12]) * w3;
      oy +=
        (combined[m + 1] * px + combined[m + 5] * py + combined[m + 9] * pz + combined[m + 13]) * w3;
      oz +=
        (combined[m + 2] * px + combined[m + 6] * py + combined[m + 10] * pz + combined[m + 14]) * w3;
      totalWeight += w3;
    }

    if (totalWeight > 0) {
      baked[i * 3] = ox;
      baked[i * 3 + 1] = oy;
      baked[i * 3 + 2] = oz;
    } else {
      // No usable influence — leave the vertex at its bind-pose position so we
      // don't emit (0,0,0) garbage that would skew downstream geometry bounds.
      baked[i * 3] = px;
      baked[i * 3 + 1] = py;
      baked[i * 3 + 2] = pz;
    }
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(baked, 3));
  return true;
}

function getDirectVec3Reader(
  attribute: SkinAttribute,
): { array: ArrayLike<number>; stride: number } | null {
  // InterleavedBufferAttribute exposes `.data.array` and `.offset`/`.data.stride`,
  // which we don't currently optimize for — fall back to getX/Y/Z in that case.
  if ((attribute as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) {
    return null;
  }
  const buffer = attribute as THREE.BufferAttribute;
  const stride = buffer.itemSize;
  if (stride !== 3) return null;
  const array = buffer.array;
  if (!array) return null;
  return { array, stride };
}

function getDirectVec4Reader(
  attribute: SkinAttribute,
): { array: ArrayLike<number>; stride: number } | null {
  if ((attribute as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) {
    return null;
  }
  const buffer = attribute as THREE.BufferAttribute;
  const stride = buffer.itemSize;
  if (stride !== 4) return null;
  const array = buffer.array;
  if (!array) return null;
  return { array, stride };
}

/** Original per-vertex bake with full diagnostics. Used when body-chart debug
 * mode is enabled; otherwise we run the faster bakeSkinnedGeometryFast path. */
function bakeSkinnedGeometryDiagnostic(
  mesh: THREE.SkinnedMesh,
  geometry: THREE.BufferGeometry,
  debugLabel: string,
  position: SkinAttribute,
  skinIndex: SkinAttribute,
  skinWeight: SkinAttribute,
): boolean {
  const skeleton = mesh.skeleton;
  const diagnostics = {
    transformedVertexCount: 0,
    invalidInfluenceCount: 0,
    noPositiveWeightCount: 0,
    invalidBoneIndexCount: 0,
    missingBoneCount: 0,
    nonFiniteBoneIndexCount: 0,
    invalidSamples: [] as Array<{
      vertexIndex: number;
      reason: SkinInfluenceInspection['reason'];
      boneIndices: number[];
      weights: number[];
    }>,
  };

  skeleton.update();

  const baked = new Float32Array(position.count * 3);
  const vertex = new THREE.Vector3();
  let transformedVertexCount = 0;

  for (let index = 0; index < position.count; index++) {
    vertex.fromBufferAttribute(position, index);

    const influence = inspectSkinInfluence(skinIndex, skinWeight, index, skeleton.bones);
    if (influence.usable) {
      mesh.applyBoneTransform(index, vertex);
      transformedVertexCount += 1;
      diagnostics.transformedVertexCount += 1;
    } else {
      diagnostics.invalidInfluenceCount += 1;
      if (influence.reason === 'no-positive-weight') diagnostics.noPositiveWeightCount += 1;
      if (influence.reason === 'invalid-bone-index') diagnostics.invalidBoneIndexCount += 1;
      if (influence.reason === 'missing-bone') diagnostics.missingBoneCount += 1;
      if (influence.reason === 'non-finite-bone-index') diagnostics.nonFiniteBoneIndexCount += 1;
      if (diagnostics.invalidSamples.length < 5) {
        diagnostics.invalidSamples.push({
          vertexIndex: index,
          reason: influence.reason,
          boneIndices: influence.boneIndices,
          weights: influence.weights,
        });
      }
    }

    baked[index * 3] = vertex.x;
    baked[index * 3 + 1] = vertex.y;
    baked[index * 3 + 2] = vertex.z;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(baked, 3));

  if (shouldSampleBodyChartDebug(`posedGeometry:${debugLabel}:bake`, 4)) {
    bodyChartDebugLog('posedGeometry skinned bake summary', {
      mesh: debugLabel,
      vertexCount: position.count,
      transformedVertexCount,
      invalidInfluenceCount: diagnostics.invalidInfluenceCount,
      noPositiveWeightCount: diagnostics.noPositiveWeightCount,
      invalidBoneIndexCount: diagnostics.invalidBoneIndexCount,
      missingBoneCount: diagnostics.missingBoneCount,
      nonFiniteBoneIndexCount: diagnostics.nonFiniteBoneIndexCount,
      invalidSamples: diagnostics.invalidSamples,
      boneCount: skeleton.bones.length,
      skeletonKind: detectSkeletonKind(skeleton.bones),
      boneSample: skeleton.bones.slice(0, 8).map((bone) => bone.name || '(unnamed)'),
    });
  }

  return transformedVertexCount > 0;
}

export function isSkinnedMesh(mesh: THREE.Mesh): mesh is THREE.SkinnedMesh {
  return (mesh as THREE.SkinnedMesh).isSkinnedMesh === true;
}

function getMeshDebugLabel(mesh: THREE.Mesh): string {
  return mesh.name || mesh.parent?.name || mesh.uuid;
}

function summarizeSkinnedMesh(mesh: THREE.SkinnedMesh) {
  const bones = mesh.skeleton?.bones ?? [];
  return {
    mesh: getMeshDebugLabel(mesh),
    geometryUuid: mesh.geometry.uuid,
    indexed: Boolean(mesh.geometry.index),
    positionCount: mesh.geometry.getAttribute('position')?.count ?? 0,
    uvCount: mesh.geometry.getAttribute('uv')?.count ?? 0,
    skinIndexCount: mesh.geometry.getAttribute('skinIndex')?.count ?? 0,
    skinWeightCount: mesh.geometry.getAttribute('skinWeight')?.count ?? 0,
    boneCount: bones.length,
    skeletonKind: detectSkeletonKind(bones),
    boneSample: bones.slice(0, 8).map((bone: THREE.Bone) => bone.name || '(unnamed)'),
  };
}

export type DetectedSkeletonKind = 'cc' | 'unknown';

export function detectSkeletonKind(bones: THREE.Bone[]): DetectedSkeletonKind {
  for (const bone of bones) {
    const name = bone.name || '';
    if (/^CC_Base_/.test(name)) return 'cc';
  }
  return 'unknown';
}

type SkinInfluenceInspection =
  | {
      usable: true;
      reason: 'ok';
      boneIndices: number[];
      weights: number[];
    }
  | {
      usable: false;
      reason:
        | 'no-positive-weight'
        | 'invalid-bone-index'
        | 'missing-bone'
        | 'non-finite-bone-index';
      boneIndices: number[];
      weights: number[];
    };

function inspectSkinInfluence(
  skinIndex: SkinAttribute,
  skinWeight: SkinAttribute,
  vertexIndex: number,
  bones: THREE.Bone[],
): SkinInfluenceInspection {
  let hasPositiveWeight = false;
  const boneIndices: number[] = [];
  const weights: number[] = [];

  for (let component = 0; component < 4; component += 1) {
    const weight = readAttributeComponent(skinWeight, vertexIndex, component);
    weights.push(weight);
    if (!Number.isFinite(weight) || weight <= 0) continue;

    hasPositiveWeight = true;
    const boneIndex = readAttributeComponent(skinIndex, vertexIndex, component);
    boneIndices.push(boneIndex);
    if (!Number.isFinite(boneIndex)) {
      return {
        usable: false,
        reason: 'non-finite-bone-index',
        boneIndices,
        weights,
      };
    }

    const normalizedBoneIndex = Math.trunc(boneIndex);
    if (normalizedBoneIndex < 0 || normalizedBoneIndex >= bones.length) {
      return {
        usable: false,
        reason: 'invalid-bone-index',
        boneIndices,
        weights,
      };
    }
    if (!bones[normalizedBoneIndex]) {
      return {
        usable: false,
        reason: 'missing-bone',
        boneIndices,
        weights,
      };
    }
  }

  if (!hasPositiveWeight) {
    return {
      usable: false,
      reason: 'no-positive-weight',
      boneIndices,
      weights,
    };
  }

  return {
    usable: true,
    reason: 'ok',
    boneIndices,
    weights,
  };
}

function readAttributeComponent(
  attribute: SkinAttribute,
  vertexIndex: number,
  component: number,
): number {
  switch (component) {
    case 0:
      return attribute.getX(vertexIndex);
    case 1:
      return attribute.getY(vertexIndex);
    case 2:
      return attribute.getZ(vertexIndex);
    case 3:
      return attribute.getW(vertexIndex);
    default:
      return Number.NaN;
  }
}
