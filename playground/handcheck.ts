/**
 * VISUAL VERIFICATION HARNESS for the finger curl (dev-only, not shipped).
 *
 * Renders the real runtime rig's right hand at a range of commanded curls and,
 * alongside each frame, the angle the engine MEASURES back off that exact pose —
 * so the picture and the number are the same sample, not two runs that might
 * disagree. Also renders the gait tenodesis cycle so the wrist/finger coupling
 * can be eyeballed and read at once.
 *
 * Serve with `vite --config playground/vite.playground.ts`, open /handcheck.html.
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
import {
  buildCommandPose,
  measureCommandMotion,
  resolveCommandTarget,
  type ExamMovementCommand,
} from '../src/services/movementCommand';
import { resolveComposedMotion, buildSequencePoses } from '../src/services/motionSequence';
import {
  MOVEMENT_TEMPLATES,
  spinalGaitCoordination,
  templateToComposedMotion,
} from '../src/services/movementTemplates';
import { BODY_VARIANTS } from '../src/anatomy/bodyVariants';
import type { CustomPose } from '../src/types';

const cfg = BODY_VARIANTS.male;
const DIGITS = ['Thumb1', 'Index1', 'Mid1', 'Ring1', 'Pinky1'] as const;
const SIZE = 210;

const out = document.getElementById('out')!;

function section(title: string, sub: string): HTMLElement {
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
  const lookup = buildBoneByPoseKey(skinned.skeleton, cfg);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1013);
  scene.add(root);
  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(1, 1.6, 1.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88bbff, 1.1);
  rim.position.set(-1.2, 0.4, -1);
  scene.add(rim);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE);
  renderer.setPixelRatio(2);
  const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 10);

  /** Frame the right hand from the ULNAR side, where a curl reads in profile.
   *  The camera is placed in the HAND's OWN basis, so the arm can swing through
   *  the gait cycle and every frame still shows the same view of the hand —
   *  otherwise the fingers curl out of shot exactly when they matter most. */
  const HAND_CHAIN = [
    'R_Hand',
    ...DIGITS.flatMap((d) => [d, `${d.slice(0, -1)}2`, `${d.slice(0, -1)}3`]).map((b) => `R_${b}`),
  ];
  const wp = (k: string) => lookup.get(k)!.getWorldPosition(new THREE.Vector3());
  function frameHand() {
    root.updateMatrixWorld(true);
    const pts = HAND_CHAIN.filter((k) => lookup.get(k)).map(wp);
    const focus = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    const radius = Math.max(...pts.map((p) => p.distanceTo(focus)), 0.02);

    // Anatomical axes, derived from the bones themselves rather than assumed from
    // the hand's local frame — the digits move, so an assumed axis can end up
    // parallel to the up vector and degenerate the view.
    const longAxis = wp('R_Mid1').sub(wp('R_Hand')).normalize();
    const across = wp('R_Pinky1').sub(wp('R_Index1')).normalize(); // ulnar ← radial
    const view = across.clone().sub(longAxis.clone().multiplyScalar(across.dot(longAxis))).normalize();

    const dist = (radius * 1.9) / Math.tan((camera.fov * Math.PI) / 360);
    camera.position.copy(focus).addScaledVector(view, dist);
    camera.up.copy(longAxis);
    camera.lookAt(focus);
    camera.updateProjectionMatrix();
  }

  function shot(grid: HTMLElement, label: string, measured: string, joints: string) {
    renderer.render(scene, camera);
    const cell = document.createElement('div');
    cell.className = 'cell';
    const img = new Image();
    img.src = renderer.domElement.toDataURL();
    img.width = SIZE;
    img.height = SIZE;
    const lab = document.createElement('div');
    lab.className = 'lab';
    lab.innerHTML = `${label} <span class="m">${measured}</span><span class="j">${joints}</span>`;
    cell.append(img, lab);
    grid.append(cell);
  }

  function apply(pose: CustomPose) {
    applyCustomPose(skinned.skeleton, cfg, pose);
    root.updateMatrixWorld(true);
    return computeJointAngles(skinned.skeleton, cfg, 'male', rest);
  }

  const localDeg = (poseKey: string, base: CustomPose, now: CustomPose): number => {
    const a = base.bones?.[poseKey];
    const b = now.bones?.[poseKey];
    if (!a || !b) return 0;
    const qa = new THREE.Quaternion(a[0], a[1], a[2], a[3]);
    const qb = new THREE.Quaternion(b[0], b[1], b[2], b[3]);
    const d = qa.invert().multiply(qb);
    return (2 * Math.acos(Math.min(1, Math.abs(d.w))) * 180) / Math.PI;
  };

  // ── 1. Commanded curl sweep: all five digits together, so the hand reads as a
  //       hand rather than one finger moving on a flat paddle. ────────────────
  const g1 = section(
    'Commanded curl — all five digits',
    'Each frame is one pose. “measured” is computeJointAngles read back off that same pose; MCP/PIP/DIP are the local bone rotations that realized it.',
  );
  for (const deg of [0, 15, 30, 45, 60, 90, 120, 160]) {
    let pose: CustomPose = baselinePose;
    for (const d of DIGITS) {
      const cmd: ExamMovementCommand = {
        action: 'set-joint',
        joint: `R_${d}`,
        motion: 'fingerFlexion',
        targetDegrees: deg,
      };
      const r = resolveCommandTarget(cmd, cfg);
      pose = buildCommandPose(baselinePose, cmd, r.clampedDegrees!, cfg, pose, rest) ?? pose;
    }
    const report = apply(pose);
    frameHand();
    const mid = measureCommandMotion(report, 'R_Mid1', 'fingerFlexion')!;
    const idx = measureCommandMotion(report, 'R_Index1', 'fingerFlexion')!;
    shot(
      g1,
      `cmd <b>${deg}°</b> →`,
      `mid ${mid.toFixed(1)}° · index ${idx.toFixed(1)}°`,
      `R_Mid MCP ${localDeg('R_Mid1', baselinePose, pose).toFixed(0)}° · PIP ${localDeg('R_Mid2', baselinePose, pose).toFixed(0)}° · DIP ${localDeg('R_Mid3', baselinePose, pose).toFixed(0)}°`,
    );
  }

  // ── 2. The gait cycle: tenodesis coupling, wrist and fingers together. ─────
  const g2 = section(
    'Walk cycle — tenodesis coupling',
    'Every keyframe of the composed walk. Wrist extension should tighten the digits and wrist flexion release them.',
  );
  const walk = spinalGaitCoordination(
    templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!, cfg),
  );
  const resolved = resolveComposedMotion(walk, cfg);
  const seq = buildSequencePoses(baselinePose, resolved, cfg, rest);
  seq.poses.forEach((pose, i) => {
    const report = apply(pose);
    frameHand();
    const wrist = measureCommandMotion(report, 'R_Hand', 'wristFlexion')!;
    const mid = measureCommandMotion(report, 'R_Mid1', 'fingerFlexion')!;
    const ring = measureCommandMotion(report, 'R_Ring1', 'fingerFlexion')!;
    shot(
      g2,
      `kf <b>${i}</b>`,
      `wrist ${wrist.toFixed(1)}°`,
      `<span class="d">mid ${mid.toFixed(1)}° · ring ${ring.toFixed(1)}°</span>`,
    );
  });

  document.body.dataset.ready = 'true';
}

main().catch((e) => {
  document.body.textContent = `FAILED: ${String(e)}`;
  document.body.dataset.ready = 'error';
});
