import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, computeJointAngles } from '../services/jointAngles';
import { buildCommandPose, buildComposedCommandPose, girdleSplit, type ComposedJointTarget } from '../services/movementCommand';
import { buildSequencePoses, resolveComposedMotion, type SequenceTarget } from '../services/motionSequence';
import { buildTravelRun, buildTravelWalk } from '../services/movementLocomotion';
import { LIMB_SEGMENTS, measureLimbClearance, type LimbSegment, type Vec3 } from '../services/limbClearance';

// Read the actual shoulder-to-elbow axis. A numeric readout alone cannot catch
// a pose mirrored into the wrong hemisphere (the original tan construction).
describe.each(['male', 'female'] as const)('%s composed shoulder geometry', (variant) => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D;
  let skeleton: THREE.Skeleton;
  let bones: Map<string, THREE.Bone>;
  let baseline: ReturnType<typeof serializeCustomPose>;
  let rest: ReturnType<typeof captureJointAngleRestReference>;
  let clearanceSegments: LimbSegment[];
  type MeshVertex = { mesh: THREE.SkinnedMesh; index: number };
  const handVertices: MeshVertex[] = [];
  const legVertices: MeshVertex[] = [];

  beforeAll(async () => {
    const buf = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    root = gltf.scene;
    root.scale.setScalar(cfg.pose.rootScale);
    const meshes: THREE.SkinnedMesh[] = [];
    root.traverse(o => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        meshes.push(o as THREE.SkinnedMesh);
        if (!skeleton) skeleton = (o as THREE.SkinnedMesh).skeleton;
      }
    });
    root.updateMatrixWorld(true);
    applyAnatomicPose(root, cfg);
    root.updateMatrixWorld(true);
    bones = buildBoneByPoseKey(skeleton, cfg);
    rest = captureJointAngleRestReference(skeleton, cfg);
    baseline = serializeCustomPose(skeleton, cfg, variant);
    // The production default radii were measured on the male mesh. Calibrate
    // each asset here using the same dominant-weight/p90 convention as the
    // existing limb-clearance gate, so female validation measures her geometry.
    clearanceSegments = LIMB_SEGMENTS.map(segment => {
      const side = segment.id[0];
      const kind = segment.id.slice(2);
      const pattern = kind === 'thigh' ? 'Thigh|ThighTwist\\d+'
        : kind === 'shank' ? 'Calf|CalfTwist\\d+'
          : kind === 'forearm' ? 'Forearm|ForearmTwist\\d+'
            : 'Hand|Index[123]|Mid[123]|Ring[123]|Pinky[123]|Thumb[123]';
      const re = new RegExp(`_${side}_(${pattern})$`);
      const a = bones.get(segment.from)!.getWorldPosition(new THREE.Vector3());
      const b = bones.get(kind === 'hand' ? `${side}_Mid2` : segment.to)!.getWorldPosition(new THREE.Vector3());
      const axis = b.clone().sub(a);
      const distances: number[] = [];
      for (const mesh of meshes) {
        const positions = mesh.geometry.attributes.position;
        const indices = mesh.geometry.attributes.skinIndex;
        const weights = mesh.geometry.attributes.skinWeight;
        for (let i = 0; i < positions.count; i++) {
          let dominant = 0;
          for (let k = 1; k < 4; k++) {
            if (weights.getComponent(i, k) > weights.getComponent(i, dominant)) dominant = k;
          }
          if (!re.test(mesh.skeleton.bones[indices.getComponent(i, dominant)].name)) continue;
          if (kind === 'hand') handVertices.push({ mesh, index: i });
          else if (kind === 'thigh' || kind === 'shank') legVertices.push({ mesh, index: i });
          const p = new THREE.Vector3().fromBufferAttribute(positions, i);
          mesh.applyBoneTransform(i, p);
          mesh.localToWorld(p);
          const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(axis) / axis.lengthSq()));
          distances.push(p.distanceTo(a.clone().addScaledVector(axis, t)));
        }
      }
      expect(distances.length).toBeGreaterThan(0);
      distances.sort((x, y) => x - y);
      return { ...segment, radiusM: distances[Math.floor(distances.length * 0.9)] };
    });
  });

  function apply(side: 'L' | 'R', targets: ComposedJointTarget[]): THREE.Vector3 {
    const pose = buildComposedCommandPose(baseline, `${side}_UpperArm`, targets, cfg, null, rest)!;
    expect(pose).not.toBeNull();
    applyCustomPose(skeleton, cfg, pose);
    root.updateMatrixWorld(true);
    return bones.get(`${side}_Forearm`)!.getWorldPosition(new THREE.Vector3())
      .sub(bones.get(`${side}_UpperArm`)!.getWorldPosition(new THREE.Vector3())).normalize();
  }

  function sequence(frames: SequenceTarget[][]) {
    const resolved = resolveComposedMotion({
      startFrom: 'neutral',
      keyframes: frames.map(targets => ({ durationMs: 1000, targets })),
    }, cfg);
    expect(resolved.status).toBe('ok');
    return buildSequencePoses(baseline, resolved, cfg, rest).poses;
  }

  function read(pose: typeof baseline, side: 'L' | 'R') {
    applyCustomPose(skeleton, cfg, pose);
    root.updateMatrixWorld(true);
    return {
      angles: computeJointAngles(skeleton, cfg, variant, rest).joints,
      arm: bones.get(`${side}_UpperArm`)!.getWorldQuaternion(new THREE.Quaternion()).normalize(),
      forearm: bones.get(`${side}_Forearm`)!.getWorldQuaternion(new THREE.Quaternion()).normalize(),
      hand: bones.get(`${side}_Hand`)!.getWorldQuaternion(new THREE.Quaternion()).normalize(),
      direction: bones.get(`${side}_Forearm`)!.getWorldPosition(new THREE.Vector3())
        .sub(bones.get(`${side}_UpperArm`)!.getWorldPosition(new THREE.Vector3())).normalize(),
    };
  }

  it.each(['L', 'R'] as const)('%s: explicit 10-degree tilt and 120-degree flexion survive either target order', side => {
    const arm = { joint: `${side}_UpperArm`, motion: 'shoulderFlexion', targetDegrees: 120 };
    const girdle = { joint: `${side}_Shoulder`, motion: 'scapularTilt', targetDegrees: 10 };
    const reference = read(sequence([[arm]])[0], side);
    for (const targets of [[arm, girdle], [girdle, arm]]) {
      const result = read(sequence([targets])[0], side);
      expect(result.angles[arm.joint].shoulderFlexion).toBeCloseTo(120, 4);
      expect(result.angles[girdle.joint].scapularTilt).toBeCloseTo(10, 4);
      expect(Math.abs(result.angles[arm.joint].shoulderRotation)).toBeLessThan(1e-4);
      expect(result.arm.angleTo(reference.arm)).toBeLessThan(1e-6);
      expect(result.hand.angleTo(reference.hand)).toBeLessThan(1e-6);
    }
  });

  it.each(['L', 'R'] as const)('%s: combined elevation and axial rotation preserve reach and palm orientation across girdle permutations', side => {
    const arm = `${side}_UpperArm`;
    const girdle = `${side}_Shoulder`;
    const armTargets = [
      { joint: arm, motion: 'shoulderFlexion', targetDegrees: 60 },
      { joint: arm, motion: 'shoulderAbduction', targetDegrees: 40 },
      { joint: arm, motion: 'shoulderRotation', targetDegrees: 35 },
    ];
    const girdleTargets = [
      { joint: girdle, motion: 'scapularTilt', targetDegrees: 7 },
      { joint: girdle, motion: 'upRotation', targetDegrees: 11 },
      { joint: girdle, motion: 'protraction', targetDegrees: 12 },
    ];
    const distal = [
      { joint: `${side}_Forearm`, motion: 'elbowFlexion', targetDegrees: 80 },
      { joint: `${side}_Forearm`, motion: 'forearmRotation', targetDegrees: 45 },
      { joint: `${side}_Hand`, motion: 'wristFlexion', targetDegrees: 20 },
      { joint: `${side}_Hand`, motion: 'wristDeviation', targetDegrees: 10 },
    ];
    const reference = read(sequence([[...armTargets, ...distal]])[0], side);
    const all = [...armTargets, ...girdleTargets];
    // Cyclic shifts plus reversal exercise every shoulder field before and
    // after its parent and the other arm axes, without changing distal intent.
    for (let offset = 0; offset < all.length; offset++) {
      const shifted = [...all.slice(offset), ...all.slice(0, offset)];
      for (const ordered of [shifted, [...shifted].reverse()]) {
        const result = read(sequence([[...ordered, ...distal]])[0], side);
        // The GLB long axis differs slightly from the canonical twist axis;
        // its existing sub-0.02-degree readout residual is unchanged by girdle.
        for (const t of armTargets) {
          expect(Math.abs(result.angles[arm][t.motion] - t.targetDegrees)).toBeLessThan(0.02);
          expect(result.angles[arm][t.motion]).toBeCloseTo(reference.angles[arm][t.motion], 4);
        }
        for (const t of girdleTargets) expect(result.angles[girdle][t.motion]).toBeCloseTo(t.targetDegrees, 4);
        expect(result.direction.distanceTo(reference.direction)).toBeLessThan(1e-6);
        expect(result.arm.angleTo(reference.arm)).toBeLessThan(1e-6);
        expect(result.forearm.angleTo(reference.forearm)).toBeLessThan(1e-6);
        // Full hand orientation includes its palm normal AND longitudinal axis.
        expect(result.hand.angleTo(reference.hand)).toBeLessThan(1e-6);
      }
    }
  });

  it.each(['L', 'R'] as const)('%s: explicit axes override rhythm without leaking into the next keyframe', side => {
    const arm = `${side}_UpperArm`;
    const girdle = `${side}_Shoulder`;
    const poses = sequence([
      [
        { joint: arm, motion: 'shoulderFlexion', targetDegrees: 120 },
        { joint: arm, motion: 'shoulderAbduction', targetDegrees: 100 },
        { joint: girdle, motion: 'scapularTilt', targetDegrees: 0 },
        { joint: girdle, motion: 'protraction', targetDegrees: 6 },
      ],
      [{ joint: arm, motion: 'shoulderFlexion', targetDegrees: 20 }],
    ]);
    const high = read(poses[0], side).angles;
    expect(high[girdle].scapularTilt).toBeCloseTo(0, 4);
    expect(high[girdle].upRotation).toBeCloseTo(girdleSplit(100, 'abduction').girdle, 4);
    const low = read(poses[1], side).angles;
    expect(low[girdle].scapularTilt).toBeCloseTo(0, 4);
    expect(low[girdle].upRotation).toBeCloseTo(0, 4);
    expect(low[girdle].protraction).toBeCloseTo(6, 4);
    expect(low[arm].shoulderFlexion).toBeCloseTo(20, 4);
    expect(Math.abs(low[arm].shoulderRotation)).toBeLessThan(1e-4);
  });

  it.each(['L', 'R'] as const)('%s: a girdle-only command still carries the arm', side => {
    const arm = { joint: `${side}_UpperArm`, motion: 'shoulderFlexion', targetDegrees: 40 };
    const poses = sequence([[arm], [{ joint: `${side}_Shoulder`, motion: 'scapularTilt', targetDegrees: 10 }]]);
    expect(poses[1].bones[arm.joint]).toEqual(poses[0].bones[arm.joint]);
    expect(read(poses[1], side).angles[arm.joint].shoulderFlexion).toBeCloseTo(50, 4);
  });

  it.each(['L', 'R'] as const)('%s: single commands compensate carried protraction consistently with keyframes', side => {
    const from = sequence([[{ joint: `${side}_Shoulder`, motion: 'protraction', targetDegrees: 15 }]])[0];
    const joint = `${side}_UpperArm`;
    const single = buildCommandPose(baseline, { action: 'set-joint', joint, motion: 'shoulderFlexion', targetDegrees: 120 }, 120, cfg, from, rest)!;
    const composed = buildComposedCommandPose(baseline, joint, [{ motion: 'shoulderFlexion', degrees: 120 }], cfg, from, rest)!;
    const result = read(single, side);
    expect(result.angles[joint].shoulderFlexion).toBeCloseTo(120, 4);
    expect(result.angles[`${side}_Shoulder`].protraction).toBeCloseTo(15, 4);
    expect(result.hand.angleTo(read(composed, side).hand)).toBeLessThan(1e-6);
  });

  it.each(['L', 'R'] as const)('%s: an axial-only arm command preserves the girdle and its requested axial orientation', side => {
    const arm = `${side}_UpperArm`;
    const girdle = `${side}_Shoulder`;
    const poses = sequence([
      [
        { joint: arm, motion: 'shoulderFlexion', targetDegrees: 120 },
        { joint: girdle, motion: 'scapularTilt', targetDegrees: 10 },
      ],
      [{ joint: arm, motion: 'shoulderRotation', targetDegrees: 25 }],
    ]);
    const result = read(poses[1], side).angles;
    expect(result[girdle].scapularTilt).toBeCloseTo(10, 4);
    expect(result[arm].shoulderRotation).toBeCloseTo(25, 3);
    expect(Math.abs(result[arm].shoulderFlexion)).toBeLessThan(0.02);
  });

  it('keeps explicit girdle targets when no rest reference or arm bone is available', () => {
    const arm = { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 120 };
    const girdle = { joint: 'L_Shoulder', motion: 'scapularTilt', targetDegrees: 10 };
    const expected = buildComposedCommandPose(baseline, girdle.joint, [{ motion: girdle.motion, degrees: 10 }], cfg)!;
    const partial = { ...baseline, bones: { ...baseline.bones } };
    delete partial.bones[arm.joint];
    for (const base of [baseline, partial]) {
      for (const targets of [[arm, girdle], [girdle, arm]]) {
        const resolved = resolveComposedMotion({ startFrom: 'neutral', keyframes: [{ durationMs: 1000, targets }] }, cfg);
        const pose = buildSequencePoses(base, resolved, cfg).poses[0];
        expect(new THREE.Quaternion(...pose.bones[girdle.joint]).normalize()
          .angleTo(new THREE.Quaternion(...expected.bones[girdle.joint]).normalize())).toBeLessThan(1e-6);
      }
    }
  });

  it.each([
    ['walk', buildTravelWalk], ['run', buildTravelRun],
  ] as const)('%s: reversing targets retains the authored gait girdle channels', (_name, build) => {
    const resolved = resolveComposedMotion(build(), cfg);
    expect(resolved.status).toBe('ok');
    const reverse = { ...resolved, keyframes: resolved.keyframes.map(kf => ({ ...kf, targets: [...kf.targets].reverse() })) };
    const normalPoses = buildSequencePoses(baseline, resolved, cfg, rest).poses;
    const reversePoses = buildSequencePoses(baseline, reverse, cfg, rest).poses;
    const peaks = { scapularTilt: 0, upRotation: 0 };
    for (let i = 0; i < normalPoses.length; i++) {
      for (const side of ['L', 'R']) {
        const girdle = `${side}_Shoulder`;
        for (const joint of [girdle, `${side}_UpperArm`]) {
          expect(new THREE.Quaternion(...normalPoses[i].bones[joint])
            .angleTo(new THREE.Quaternion(...reversePoses[i].bones[joint]))).toBeLessThan(1e-6);
        }
        const explicit = resolved.keyframes[i].targets.filter(t => t.joint === girdle);
        if (!explicit.length) continue;
        const authored = buildComposedCommandPose(baseline, girdle,
          explicit.map(t => ({ motion: t.motion, degrees: t.clampedDegrees })), cfg, baseline, rest)!;
        expect(new THREE.Quaternion(...normalPoses[i].bones[girdle])
          .angleTo(new THREE.Quaternion(...authored.bones[girdle]))).toBeLessThan(1e-6);
        for (const t of explicit) {
          if (t.motion === 'scapularTilt' || t.motion === 'upRotation') {
            peaks[t.motion] = Math.max(peaks[t.motion], Math.abs(t.clampedDegrees));
          }
        }
      }
    }
    expect(peaks.scapularTilt).toBeGreaterThan(1);
    expect(peaks.upRotation).toBeGreaterThan(1);
  });

  it.each([
    ['walk', buildTravelWalk], ['run', buildTravelRun],
  ] as const)('%s: recalibrated carriage retains clearance at every authored swing endpoint', (name, build) => {
    const resolved = resolveComposedMotion(build(), cfg);
    const poses = buildSequencePoses(baseline, resolved, cfg, rest).poses;
    const sample = (vertices: MeshVertex[], n: number) => vertices.filter((_, i) => i % Math.max(1, Math.floor(vertices.length / n)) === 0);
    const hands = sample(handVertices, 220);
    const legs = sample(legVertices, 420);
    const point = ({ mesh, index }: MeshVertex) => {
      const p = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, index);
      mesh.applyBoneTransform(index, p);
      return mesh.localToWorld(p);
    };
    let meshClearance = Infinity;
    const tracks = poses.map(pose => {
      applyCustomPose(skeleton, cfg, pose);
      root.updateMatrixWorld(true);
      const frame: Record<string, Vec3> = {};
      for (const [key, bone] of bones) {
        const p = bone.getWorldPosition(new THREE.Vector3());
        frame[key] = [p.x, p.y, p.z];
      }
      const handPoints = hands.map(point), legPoints = legs.map(point);
      for (const h of handPoints) for (const l of legPoints) meshClearance = Math.min(meshClearance, h.distanceTo(l));
      return frame;
    });
    const clearance = measureLimbClearance(tracks, { segments: clearanceSegments });
    expect(clearance.untracked).toEqual([]);
    console.log(`${variant} ${name} shoulder endpoints: worst capsule ${(clearance.worstM * 100).toFixed(2)} cm, sampled mesh ${(meshClearance * 100).toFixed(2)} cm`);
    expect(clearance.worstM).toBeGreaterThan(0);
    expect(meshClearance).toBeGreaterThan(0.01);
    expect(clearance.worstM).toBeLessThanOrEqual(meshClearance);
  });

  it.each(['L', 'R'] as const)('%s: adding a zero shoulder field preserves the single-plane reach', side => {
    for (const motion of ['shoulderFlexion', 'shoulderAbduction']) {
      const other = motion === 'shoulderFlexion' ? 'shoulderAbduction' : 'shoulderFlexion';
      for (const degrees of [-30, 0, 45, 89, 90, 91, 120, 160, 170, 180]) {
        const single = apply(side, [{ motion, degrees }]);
        for (const extra of [other, 'shoulderRotation']) {
          const composed = apply(side, [{ motion, degrees }, { motion: extra, degrees: 0 }]);
          expect(composed.distanceTo(single), `${side} ${motion}=${degrees}, ${extra}=0`).toBeLessThan(1e-6);
        }
      }
    }
  });

  it.each(['L', 'R'] as const)('%s: reconstructs compatible projected angles in every spatial quadrant', side => {
    const s = side === 'R' ? -1 : 1;
    const rd = new THREE.Vector3(...rest.worldDirs![`${side}_UpperArm`]);
    const f0 = Math.atan2(rd.z, -rd.y);
    const a0 = Math.atan2(s * rd.x, -rd.y);
    // Generate independent world directions, then derive their two projections.
    // Arbitrary F x A pairs can disagree about the sign of Y; those do not
    // describe a possible arm direction and are not a full-sphere test.
    for (const elevation of [5, 45, 89, 91, 120, 170, 175]) {
      for (const azimuth of [-175, -135, -90, -45, -5, 5, 45, 90, 135, 175]) {
        const e = elevation * Math.PI / 180;
        const a = azimuth * Math.PI / 180;
        const wanted = new THREE.Vector3(s * Math.sin(e) * Math.sin(a), -Math.cos(e), Math.sin(e) * Math.cos(a));
        const actual = apply(side, [
          { motion: 'shoulderFlexion', degrees: (Math.atan2(wanted.z, -wanted.y) - f0) * 180 / Math.PI },
          { motion: 'shoulderAbduction', degrees: (Math.atan2(s * wanted.x, -wanted.y) - a0) * 180 / Math.PI },
        ]);
        expect(actual.distanceTo(wanted), `${side}: elevation ${elevation}, azimuth ${azimuth}`).toBeLessThan(1e-6);
      }
    }
  });

  it.each(['L', 'R'] as const)('%s: the authored 170-degree reach stays overhead through sequence building', side => {
    const joint = `${side}_UpperArm`;
    const resolved = resolveComposedMotion({
      name: 'overhead composition regression',
      startFrom: 'neutral',
      keyframes: [{ durationMs: 1000, targets: [
        { joint, motion: 'shoulderFlexion', targetDegrees: 170 },
        { joint, motion: 'shoulderAbduction', targetDegrees: 0 },
      ] }],
    }, cfg);
    expect(resolved.status).toBe('ok');
    const built = buildSequencePoses(baseline, resolved, cfg, rest);
    applyCustomPose(skeleton, cfg, built.poses[0]);
    root.updateMatrixWorld(true);
    const shoulder = bones.get(joint)!.getWorldPosition(new THREE.Vector3());
    const elbow = bones.get(`${side}_Forearm`)!.getWorldPosition(new THREE.Vector3());
    expect(elbow.y).toBeGreaterThan(shoulder.y + 0.1);
    const angles = computeJointAngles(skeleton, cfg, variant, rest);
    expect(angles.joints[joint].shoulderFlexion).toBeCloseTo(170, 5);
    // The serialized GLB/rest-quaternion round trip leaves microdegree noise.
    expect(Math.abs(angles.joints[joint].shoulderRotation)).toBeLessThan(1e-4);
  });

  it.each(['L', 'R'] as const)('%s: horizontal projections remain finite and preserve their signed directions', side => {
    const s = side === 'R' ? -1 : 1;
    const rd = new THREE.Vector3(...rest.worldDirs![`${side}_UpperArm`]);
    for (const forward of [-1, 1]) {
      for (const lateral of [-1, 1]) {
        const actual = apply(side, [
          { motion: 'shoulderFlexion', degrees: forward * 90 - Math.atan2(rd.z, -rd.y) * 180 / Math.PI },
          { motion: 'shoulderAbduction', degrees: lateral * 90 - Math.atan2(s * rd.x, -rd.y) * 180 / Math.PI },
        ]);
        expect(actual.distanceTo(new THREE.Vector3(s * lateral, 0, forward).normalize())).toBeLessThan(1e-6);
      }
    }
  });

  it.each(['L', 'R'] as const)('%s: conflicting projections retain the overhead, forward and lateral intent', side => {
    // 120 flexion and 20 abduction cannot both read back as projected angles:
    // one asks for positive Y, the other negative Y. Elevation takes priority;
    // this is a direction check, deliberately not an exact-angle claim.
    const actual = apply(side, [
      { motion: 'shoulderFlexion', degrees: 120 },
      { motion: 'shoulderAbduction', degrees: 20 },
    ]);
    expect(actual.y).toBeGreaterThan(0);
    expect(actual.z).toBeGreaterThan(0);
    expect(actual.x * (side === 'R' ? -1 : 1)).toBeGreaterThan(0);
  });
});
