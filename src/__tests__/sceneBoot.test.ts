import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addMannequinLights } from '../services/sceneBoot';

describe('addMannequinLights', () => {
  it('adds ambient + hemisphere + key + fill at the shared canonical positions', () => {
    const scene = new THREE.Scene();
    const rig = addMannequinLights(scene);

    expect(scene.children).toHaveLength(4);
    expect(rig.ambient).toBeInstanceOf(THREE.AmbientLight);
    expect(rig.hemisphere).toBeInstanceOf(THREE.HemisphereLight);
    expect(rig.key).toBeInstanceOf(THREE.DirectionalLight);
    expect(rig.fill).toBeInstanceOf(THREE.DirectionalLight);

    expect(rig.key.position.toArray()).toEqual([2.4, 4.2, 3.1]);
    expect(rig.fill.position.toArray()).toEqual([-2.2, 2.1, -2]);
  });

  it('defaults to the clinical palette', () => {
    const scene = new THREE.Scene();
    const rig = addMannequinLights(scene);
    expect(rig.ambient.intensity).toBeCloseTo(1.32);
    expect(rig.key.intensity).toBeCloseTo(1.7);
  });

  it('underwater palette uses cooler colors and lower intensities than clinical', () => {
    const clinical = addMannequinLights(new THREE.Scene(), 'clinical');
    const underwater = addMannequinLights(new THREE.Scene(), 'underwater');

    expect(underwater.ambient.intensity).toBeLessThan(clinical.ambient.intensity);
    expect(underwater.key.intensity).toBeLessThan(clinical.key.intensity);
    expect(underwater.fill.intensity).toBeLessThan(clinical.fill.intensity);

    // Underwater hemi sky should be visibly bluer than the near-white clinical sky.
    expect(underwater.hemisphere.color.b).toBeGreaterThan(clinical.hemisphere.color.b);
  });
});
