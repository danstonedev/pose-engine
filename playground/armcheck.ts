/**
 * ARM CARRIAGE THROUGH THE WALK (dev-only).
 *
 * Renders the composed walk from the FRONT at even phases, with the measured
 * shoulder abduction and the hand's clearance to the thigh axis beside each
 * frame — the two things that decide "close enough, but not touching".
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../src/services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../src/services/poseRig';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  type JointAngleRestReference,
} from '../src/services/jointAngles';
import { resolveComposedMotion, buildSequencePoses } from '../src/services/motionSequence';
import { buildTravelWalk } from '../src/services/movementTemplates';
import { BODY_VARIANTS } from '../src/anatomy/bodyVariants';
import type { CustomPose } from '../src/types';

const cfg = BODY_VARIANTS.male;
const SIZE = 260;
const out = document.getElementById('out')!;

async function main() {
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.load('/models/painmap3D_male.runtime.glb', res as never, undefined, rej);
  });
  const root = gltf.scene;
  root.scale.setScalar(cfg.pose.rootScale);
  let skinned!: THREE.SkinnedMesh;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, cfg);
  root.updateMatrixWorld(true);
  const rest: JointAngleRestReference = captureJointAngleRestReference(skinned.skeleton, cfg);
  const baselinePose = serializeCustomPose(skinned.skeleton, cfg, 'male');
  const map = buildBoneByPoseKey(skinned.skeleton, cfg);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1013);
  scene.add(root);
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(0.4, 1.4, 2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88bbff, 1.0);
  rim.position.set(-1.5, 0.6, -1);
  scene.add(rim);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE);
  renderer.setPixelRatio(2);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 20);

  const wp = (k: string) => map.get(k)!.getWorldPosition(new THREE.Vector3());

  /** Distance from the hand to the thigh bone axis — what it would collide with. */
  const thighGap = (S: 'L' | 'R') => {
    const hip = wp(`${S}_UpLeg`);
    const knee = wp(`${S}_Leg`);
    const hand = wp(`${S}_Hand`);
    const ax = knee.clone().sub(hip);
    const t = Math.max(0, Math.min(1, hand.clone().sub(hip).dot(ax) / ax.lengthSq()));
    return hand.distanceTo(hip.clone().addScaledVector(ax, t));
  };

  function frameBody() {
    root.updateMatrixWorld(true);
    const hips = wp('Hips');
    const focus = hips.clone().add(new THREE.Vector3(0, 0.05, 0));
    camera.position.copy(focus).add(new THREE.Vector3(0, 0.15, 2.35));
    camera.up.set(0, 1, 0);
    camera.lookAt(focus);
    camera.updateProjectionMatrix();
  }

  function section(title: string, sub: string) {
    const h = document.createElement('h1');
    h.textContent = title;
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = sub;
    const g = document.createElement('div');
    g.className = 'grid';
    out.append(h, p, g);
    return g;
  }

  function shot(grid: HTMLElement, label: string) {
    renderer.render(scene, camera);
    const cell = document.createElement('div');
    cell.className = 'cell';
    const img = new Image();
    img.src = renderer.domElement.toDataURL();
    img.width = SIZE;
    img.height = SIZE;
    const lab = document.createElement('div');
    lab.className = 'lab';
    lab.innerHTML = label;
    cell.append(img, lab);
    grid.append(cell);
  }

  // REST — the "relaxed shoulder position" the ask is measured against.
  const g0 = section('Rest', 'The relaxed shoulder position. Walk should carry the arms CLOSER than this.');
  applyAnatomicPose(root, cfg);
  frameBody();
  shot(g0, `rest · thigh gap L ${thighGap('L').toFixed(3)}m R ${thighGap('R').toFixed(3)}m`);

  // WALK — every keyframe.
  const g1 = section('Walk — every keyframe', 'Front view. "gap" is hand→thigh-axis distance; the thigh surface is ~0.08m from that axis.');
  const resolved = resolveComposedMotion(buildTravelWalk(), cfg);
  const seq = buildSequencePoses(baselinePose, resolved as never, cfg, rest);
  seq.poses.forEach((pose: CustomPose, i: number) => {
    applyCustomPose(skinned.skeleton, cfg, pose);
    root.updateMatrixWorld(true);
    const rep = computeJointAngles(skinned.skeleton, cfg, 'male', rest);
    frameBody();
    shot(
      g1,
      `kf <b>${i}</b> · gap ${thighGap('L').toFixed(3)}/${thighGap('R').toFixed(3)}m<br>` +
        `abd ${rep.joints.L_UpperArm!.shoulderAbduction.toFixed(1)}/${rep.joints.R_UpperArm!.shoulderAbduction.toFixed(1)}°`,
    );
  });

  document.body.dataset.ready = 'true';
}

main().catch((e) => {
  document.body.textContent = `FAILED: ${String(e)}`;
  document.body.dataset.ready = 'error';
});
