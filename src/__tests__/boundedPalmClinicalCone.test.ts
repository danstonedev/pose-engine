import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { buildHandPlant } from '../services/footContact';
import { solveHandContactPose } from '../services/handContactPose';
import { computeJointAngles } from '../services/jointAngles';

describe.each(['male', 'female'] as const)('%s bounded palm clinical directions', variant => {
  it('keeps the retained near-identical constrained inputs on the same bounded solution', async () => {
    const fixture = JSON.parse(readFileSync(new URL(`./fixtures/bounded-palm-${variant}-witness.json`, import.meta.url), 'utf8'));
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.modelSha256);
    const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    let skinned!: THREE.SkinnedMesh;
    root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
    const results: Array<{ quaternions: THREE.Quaternion[]; points: THREE.Vector3[] }> = [];
    for (const input of [fixture.baseline, ...fixture.perturbations.map((row: { overrides: object }) => ({ ...fixture.baseline, ...row.overrides }))]) {
      for (const entry of input.objects) {
        const node = (entry.path as number[]).reduce((current, index) => current.children[index]!, root as THREE.Object3D);
        expect(node.name).toBe(entry.name);
        node.position.fromArray(entry.position); node.quaternion.fromArray(entry.quaternion); node.scale.fromArray(entry.scale);
        node.matrixAutoUpdate = entry.matrixAutoUpdate;
        if (entry.matrix) node.matrix.fromArray(entry.matrix);
      }
      root.updateMatrixWorld(true);
      const solver = buildHandPlant(skinned, input.canonicalKeys[0], BODY_VARIANTS[variant])!;
      const target = new THREE.Vector3().fromArray(input.target);
      const result = solveHandContactPose(solver, target, new THREE.Quaternion().fromArray(input.orientation), input.rest,
        input.constraints, input.elbowDirection ? new THREE.Vector3().fromArray(input.elbowDirection) : undefined,
        input.minimumElbowY, input.elbowFlexionRadians, input.posturePrior.map((q: number[]) => new THREE.Quaternion().fromArray(q)));
      const actualError = solver.ctx.bones[0]!.getWorldPosition(new THREE.Vector3()).distanceTo(target);
      expect((result.refinement ?? result).positionErrorM).toBeCloseTo(actualError, 10);
      // The patient-limited target remains unreachable and must stay explicit.
      expect(actualError).toBeGreaterThan(.002);
      const angles = computeJointAngles(skinned.skeleton, BODY_VARIANTS[variant], variant, input.rest).joints;
      for (const key of solver.ctx.canonicalKeys) for (const [field, constraint] of Object.entries(input.constraints[key!] ?? {})) {
        const range = (constraint as { availableRange: { min: number; max: number } }).availableRange;
        const value = angles[key!]?.[field];
        expect(value).toBeDefined();
        expect(value!).toBeGreaterThanOrEqual(range.min - .01);
        expect(value!).toBeLessThanOrEqual(range.max + .01);
      }
      results.push({ quaternions: solver.ctx.bones.map(bone => bone.quaternion.clone().normalize()),
        points: solver.ctx.bones.map(bone => bone.getWorldPosition(new THREE.Vector3())) });
    }
    for (const result of results.slice(1)) for (let joint = 0; joint < result.quaternions.length; joint += 1) {
      const delta = results[0]!.quaternions[joint]!.clone().conjugate().multiply(result.quaternions[joint]!);
      const degrees = THREE.MathUtils.radToDeg(2 * Math.atan2(Math.hypot(delta.x, delta.y, delta.z), Math.abs(delta.w)));
      expect(degrees).toBeLessThan(.01);
      expect(result.points[joint]!.distanceTo(results[0]!.points[joint]!)).toBeLessThan(.0001);
    }
  });
});
