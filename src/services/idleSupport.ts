import * as THREE from 'three';

type Bones = Map<string, THREE.Bone>;

/** Infer support from the posed skeleton, including paused/scrubbed recordings. */
export function idleSupport(bones: Bones): 'standing' | 'sitting' | 'lying' {
  const hips = bones.get('Hips'), chest = bones.get('Spine_Upper');
  if (!hips || !chest) return 'sitting';
  const up = chest.getWorldPosition(new THREE.Vector3()).sub(hips.getWorldPosition(new THREE.Vector3())).normalize();
  if (Math.abs(up.y) < 0.65) return 'lying';
  for (const side of ['L', 'R']) {
    const hip = bones.get(`${side}_UpLeg`), knee = bones.get(`${side}_Leg`);
    if (!hip || !knee) return 'sitting';
    const thigh = knee.getWorldPosition(new THREE.Vector3()).sub(hip.getWorldPosition(new THREE.Vector3())).normalize();
    if (thigh.y > -0.7) return 'sitting';
  }
  return 'standing';
}

/** Small closed-chain idle correction, preserving segment lengths and foot orientation. */
export function pinIdleFeet(bones: Bones, root: THREE.Object3D, targets: Map<string, { position: THREE.Vector3; quaternion: THREE.Quaternion }>): void {
  // A root roll can put one straight leg just out of reach. Lower the pelvis
  // minimally before solving both chains, rather than stretching either leg.
  let lower = 0;
  for (const [side, target] of targets) {
    const hip = bones.get(`${side}_UpLeg`)!, knee = bones.get(`${side}_Leg`)!, foot = bones.get(`${side}_Foot`)!;
    const a = hip.getWorldPosition(new THREE.Vector3()), b = knee.getWorldPosition(new THREE.Vector3()), c = foot.getWorldPosition(new THREE.Vector3());
    const length = a.distanceTo(b) + b.distanceTo(c);
    const dx = a.x - target.position.x, dz = a.z - target.position.z;
    const height = Math.sqrt(Math.max(0, length * length - dx * dx - dz * dz));
    lower = Math.max(lower, a.y - target.position.y - height);
  }
  const rootWorld = root.getWorldPosition(new THREE.Vector3());
  rootWorld.y -= lower + 1e-7;
  root.position.copy(root.parent ? root.parent.worldToLocal(rootWorld) : rootWorld);
  root.updateMatrixWorld(true);
  for (const [side, target] of targets) {
    pinSupportLimb(root, bones.get(`${side}_UpLeg`)!, bones.get(`${side}_Leg`)!, bones.get(`${side}_Foot`)!, target.position, target.quaternion);
  }
}

/** Two-bone contact correction without changing root position or segment lengths. */
export function pinSupportLimb(root: THREE.Object3D, hip: THREE.Object3D, knee: THREE.Object3D, foot: THREE.Object3D, targetPosition: THREE.Vector3, targetQuaternion = foot.getWorldQuaternion(new THREE.Quaternion()), bendDirection?: THREE.Vector3): void {
  const rotateToward = (bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) => {
    const world = bone.getWorldQuaternion(new THREE.Quaternion());
    world.premultiply(new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize()));
    const parent = bone.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
    bone.quaternion.copy(parent.invert().multiply(world));
    root.updateMatrixWorld(true);
  };
  const a = hip.getWorldPosition(new THREE.Vector3()), b = knee.getWorldPosition(new THREE.Vector3()), c = foot.getWorldPosition(new THREE.Vector3());
  const upper = a.distanceTo(b), lowerLength = b.distanceTo(c);
  const direction = targetPosition.clone().sub(a), distance = direction.length();
  if (distance < 1e-6) return;
  direction.divideScalar(distance);
  const bend = bendDirection?.clone() ?? b.clone().sub(a);
  bend.addScaledVector(direction, -bend.dot(direction));
  if (bend.lengthSq() < 1e-10) {
    bend.set(0, 0, 1).applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()));
    bend.addScaledVector(direction, -bend.dot(direction));
  }
  bend.normalize();
  const along = THREE.MathUtils.clamp((upper * upper + distance * distance - lowerLength * lowerLength) / (2 * distance), -upper, upper);
  const desiredKnee = a.clone().addScaledVector(direction, along).addScaledVector(bend, Math.sqrt(Math.max(0, upper * upper - along * along)));
  rotateToward(hip, b.clone().sub(a), desiredKnee.clone().sub(a));
  const newKnee = knee.getWorldPosition(new THREE.Vector3());
  rotateToward(knee, foot.getWorldPosition(new THREE.Vector3()).sub(newKnee), targetPosition.clone().sub(newKnee));
  foot.quaternion.copy(foot.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(targetQuaternion));
  root.updateMatrixWorld(true);
}
