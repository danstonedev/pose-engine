import * as THREE from 'three';
import { createHandContactCalculationGraph } from '../../src/services/handContactCalculationGraph';
import type { FootPlantSolver } from '../../src/services/footContact';
import type { JointAngleRestReference } from '../../src/services/jointAngles';
import type { RomScenarioConstraints } from '../../src/services/romConstraints';
import { clampBoneToRom, clampContactHingeToRom, isHingeJoint } from '../../src/services/poseRomClamp';

/** Numerical termination and achieved residuals, not a contact acceptance verdict. */
export interface HandContactSolveResult {
  stopReason: 'not-applicable' | 'residual-tolerance' | 'search-stalled' | 'iteration-limit';
  iterations: number;
  objectiveCost?: number;
  positionErrorM?: number;
  orientationErrorRadians?: number;
  refinement?: HandContactSolveResult;
}

/** Refine an explicitly planted palm as a pose constraint. A wrist point alone
 * leaves the palm free to roll and slide. All changes remain joint rotations;
 * the target never moves and the clinical bounds still apply. */
function solveHandContactPoseCore(
  solver: FootPlantSolver,
  position: THREE.Vector3,
  orientation: THREE.Quaternion,
  rest: JointAngleRestReference | null | undefined,
  constraints?: RomScenarioConstraints | null,
  elbowDirection?: THREE.Vector3,
  minimumElbowY?: number,
  elbowFlexionRadians?: number,
  posturePrior?: readonly THREE.Quaternion[],
): HandContactSolveResult {
  if (!rest || !solver.distalCtx) return { stopReason: 'not-applicable', iterations: 0 };
  const { bones, canonicalKeys } = solver.ctx;
  const hand = bones[0]!;
  const root = bones.at(-1)!;
  const clamp = (index: number) => {
    if (index + 1 < bones.length && isHingeJoint(canonicalKeys[index]))
      clampContactHingeToRom(bones[index + 1]!, bones[index]!, canonicalKeys[index]!, rest, constraints);
    else clampBoneToRom(bones[index]!, canonicalKeys[index], rest, constraints, true, { continuousProjection: true });
  };
  for (let joint = bones.length - 1; joint >= 0; joint -= 1) clamp(joint);
  root.updateWorldMatrix(true, true);
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const point = new THREE.Vector3(), rotation = new THREE.Quaternion();
  // The finite-difference solve evaluates this residual many times. Reuse its
  // geometric scratch values; no pose state or previous-frame result is cached.
  const shoulderPoint = new THREE.Vector3(), elbowPoint = new THREE.Vector3(), wristPoint = new THREE.Vector3();
  const direction = new THREE.Vector3(), radial = new THREE.Vector3(), elbowError = new THREE.Vector3();
  const handRotation = new THREE.Quaternion(), deltaRotation = new THREE.Quaternion();
  const worldPosition = new THREE.Vector3(), worldScale = new THREE.Vector3();
  const angularScale = .12;
  const preferredElbow = () => {
    const shoulder = shoulderPoint.setFromMatrixPosition(bones[2]!.matrixWorld);
    const elbow = elbowPoint.setFromMatrixPosition(bones[1]!.matrixWorld);
    const wrist = wristPoint.setFromMatrixPosition(hand.matrixWorld);
    const a = shoulder.distanceTo(elbow), b = elbow.distanceTo(wrist);
    direction.copy(position).sub(shoulder);
    const distance = Math.max(1e-8, direction.length());
    direction.divideScalar(distance);
    radial.copy(elbowDirection!).addScaledVector(direction, -elbowDirection!.dot(direction)).normalize();
    if (elbowFlexionRadians != null) {
      // A task with authored elbow bend must not straighten early merely
      // because an unconstrained girdle makes the current reach singular.
      // Build the bend guide from the fixed wrist and segment lengths; the
      // existing bounded solve supplies the shoulder/girdle coordination.
      const reach = Math.max(1e-8, Math.sqrt(a * a + b * b + 2 * a * b * Math.cos(elbowFlexionRadians)));
      const fromWrist = Math.min(b, Math.max(-b, (b * b + reach * reach - a * a) / (2 * reach)));
      return shoulder.copy(position).addScaledVector(direction, -fromWrist)
        .addScaledVector(radial, Math.sqrt(Math.max(0, b * b - fromWrist * fromWrist)));
    }
    const along = Math.min(a, Math.max(-a, (a * a - b * b + distance * distance) / (2 * distance)));
    return shoulder.addScaledVector(direction, along).addScaledVector(radial, Math.sqrt(Math.max(0, a * a - along * along)));
  };
  const residual = (): number[] => {
    root.updateWorldMatrix(true, true);
    point.setFromMatrixPosition(hand.matrixWorld).sub(position);
    hand.matrixWorld.decompose(worldPosition, handRotation, worldScale);
    rotation.copy(orientation).multiply(handRotation.invert());
    if (rotation.w < 0) rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w);
    const length = Math.hypot(rotation.x, rotation.y, rotation.z);
    const scale = length > 1e-10 ? -angularScale * 2 * Math.atan2(length, rotation.w) / length : -2 * angularScale;
    const result = [point.x, point.y, point.z, rotation.x * scale, rotation.y * scale, rotation.z * scale];
    // A planted palm cannot be solved by folding the forearm through its
    // support plane. Keep this inequality in the final palm refinement too.
    if (minimumElbowY != null) result.push(Math.min(0, elbowError.setFromMatrixPosition(bones[1]!.matrixWorld).y - minimumElbowY));
    // A bend guide follows the shoulder. Freezing its initial world-space
    // point also constrains girdle translation and distorts shoulder motion.
    if (elbowDirection) result.push(...elbowError.setFromMatrixPosition(bones[1]!.matrixWorld).sub(preferredElbow()).multiplyScalar(.25).toArray());
    if (posturePrior?.length === bones.length) {
      // Resolve redundant solutions near the prepared bounded posture. Keep
      // the same preference in refinement so an unreachable patient target
      // cannot wander through null-space branches under tiny input changes.
      // This numerical preference is not physical stiffness or a ROM change.
      for (let joint = 0; joint < bones.length; joint += 1) {
        rotation.copy(posturePrior[joint]!).invert().multiply(bones[joint]!.quaternion).normalize();
        if (rotation.w < 0) rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w);
        const length = Math.hypot(rotation.x, rotation.y, rotation.z);
        const factor = length > 1e-10 ? angularScale * .1 * 2 * Math.atan2(length, rotation.w) / length : angularScale * .2;
        result.push(rotation.x * factor, rotation.y * factor, rotation.z * factor);
      }
    }
    return result;
  };
  const norm = (values: number[]) => values.reduce((sum, value) => sum + value * value, 0);
  let error = residual();
  let damping = 1e-5;
  let iterations = 0;
  let stopReason: HandContactSolveResult['stopReason'] = 'iteration-limit';
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    if (norm(error) < 1e-8) { stopReason = 'residual-tolerance'; break; }
    iterations = iteration + 1;
    const before = bones.map(bone => bone.quaternion.clone());
    const restore = () => bones.forEach((bone, index) => bone.quaternion.copy(before[index]!));
    const epsilon = .001;
    const rawColumns: number[][] = [];
    const feasibleColumns: number[][] = [], feasibleRotations: number[][] = [];
    let atBoundary = false;
    const captureDirection = () => {
      const turns = bones.flatMap((bone, index) => {
        if (before[index]!.equals(bone.quaternion)) return [0, 0, 0];
        const q = before[index]!.clone().invert().multiply(bone.quaternion).normalize();
        if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        const length = Math.hypot(q.x, q.y, q.z);
        const factor = length > 1e-10 ? 2 * Math.atan2(length, q.w) / (length * epsilon) : 2 / epsilon;
        return [q.x * factor, q.y * factor, q.z * factor];
      });
      feasibleRotations.push(turns);
    };
    for (let joint = 0; joint < bones.length; joint += 1) for (const axis of axes) {
      bones[joint]!.quaternion.multiply(deltaRotation.setFromAxisAngle(axis, epsilon));
      const rawPlus = residual();
      clamp(joint);
      captureDirection();
      restore();
      bones[joint]!.quaternion.multiply(deltaRotation.setFromAxisAngle(axis, -epsilon));
      const rawMinus = residual();
      clamp(joint);
      captureDirection();
      const positive = feasibleRotations.at(-2)!, negative = feasibleRotations.at(-1)!;
      atBoundary ||= positive.some((value, index) => Math.abs(value + negative[index]!) > .01);
      restore();
      rawColumns.push(rawPlus.map((value, index) => (value - rawMinus[index]!) / (2 * epsilon)));
    }
    // Diagnostic additional coupled feasible directions. The direct-parent
    // forearm/hand twist leaves all primary endpoints unchanged before bounds.
    // Its two joint rotations have a combined unit probe norm, matching the
    // ordinary coordinate generators. Without a posture objective this is an
    // exact null direction, so do not add it to the finite-difference cone.
    // Keep the same raw-J residual model.
    if (posturePrior?.length === bones.length && hand.parent === bones[1] && hand.position.lengthSq() > 1e-12) {
      const gaugeAxis=hand.position.clone().normalize();
      for(const sign of[-1,1]) {
        restore();
        const turn=new THREE.Quaternion().setFromAxisAngle(gaugeAxis,sign*epsilon/Math.SQRT2);
        bones[1]!.quaternion.multiply(turn);hand.quaternion.premultiply(turn.invert());
        for(let joint=bones.length-1;joint>=0;joint--)clamp(joint);
        captureDirection();
      }
      restore();
    }
    // Add the actual full-projected gradient direction to the feasible cone.
    // Coupled active constraints can remove the same descent from independent
    // coordinate probes. Keep the residual model and actual-cost acceptance.
    if (atBoundary) {
      const gradient = rawColumns.map(column => column.reduce((sum, value, row) => sum + value * error[row]!, 0));
      const gradientLength = Math.hypot(...gradient);
      if (gradientLength > 0) {
        restore();
        for (let joint = bones.length - 1; joint >= 0; joint -= 1) {
          const turn = new THREE.Vector3(gradient[joint * 3]!, gradient[joint * 3 + 1]!, gradient[joint * 3 + 2]!).multiplyScalar(-epsilon / gradientLength);
          const angle = turn.length();
          if (angle > 0) bones[joint]!.quaternion.multiply(deltaRotation.setFromAxisAngle(turn.divideScalar(angle), angle));
          clamp(joint);
        }
        captureDirection(); restore();
      }
    }
    // Use one residual model for both ordinary and feasible steps. Projected
    // probe rotations define feasible directions; their secant residuals
    // include curvature from the finite probe and are not a different J.
    feasibleColumns.splice(0, feasibleColumns.length, ...feasibleRotations.map(turns =>
      error.map((_, row) => rawColumns.reduce((sum, column, index) => sum + column[row]! * turns[index]!, 0))));
    // Damped least squares in residual coordinates, J' (J J' + lambda I)^-1 e.
    const size = error.length;
    const matrix = Array.from({ length: size }, (_, row) => [
      ...Array.from({ length: size }, (_, col) => rawColumns.reduce((sum, column) => sum + column[row]! * column[col]!, row === col ? damping : 0)),
      -error[row]!,
    ]);
    for (let pivot = 0; pivot < size; pivot += 1) {
      let best = pivot;
      for (let row = pivot + 1; row < size; row += 1) if (Math.abs(matrix[row]![pivot]!) > Math.abs(matrix[best]![pivot]!)) best = row;
      [matrix[pivot], matrix[best]] = [matrix[best]!, matrix[pivot]!];
      const divisor = matrix[pivot]![pivot]!;
      for (let col = pivot; col <= size; col += 1) matrix[pivot]![col] /= divisor;
      for (let row = 0; row < size; row += 1) if (row !== pivot) {
        const factor = matrix[row]![pivot]!;
        for (let col = pivot; col <= size; col += 1) matrix[row]![col] -= factor * matrix[pivot]![col]!;
      }
    }
    const delta = rawColumns.map(column => column.reduce((sum, value, row) => sum + value * matrix[row]![size]!, 0));
    const step = Math.min(1, .2 / Math.max(...delta.map(Math.abs), 1e-9));
    const errorBefore = error;
    const costBefore = norm(errorBefore);
    const modelReduction = () => {
      // The clinical projector can substantially change a proposed step. Its
      // model prediction must use the displacement actually applied, in the
      // same local quaternion coordinates as the raw residual derivatives.
      // The clipped columns already contain the projector; applying them to
      // a projected displacement would apply that constraint response twice.
      const turns = bones.flatMap((bone, index) => {
        const q = before[index]!.clone().invert().multiply(bone.quaternion).normalize();
        if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        const length = Math.hypot(q.x, q.y, q.z);
        const factor = length > 1e-10 ? 2 * Math.atan2(length, q.w) / length : 2;
        return [q.x * factor, q.y * factor, q.z * factor];
      });
      return costBefore - norm(errorBefore.map((value, row) => value + rawColumns.reduce(
        (sum, column, index) => sum + column[row]! * turns[index]!, 0)));
    };
    // Fixed four-fraction searches stopped at ~1.4 degrees when the trust
    // step hit its cap, even with smaller feasible descent still available.
    // Bound the search by floating-point resolution rather than that angle.
    const moved = () => bones.some((bone, index) => !bone.quaternion.equals(before[index]!));
    let accepted = false;
    let predictedReduction = 0;
    for (let fraction = 1; fraction > Number.EPSILON; fraction /= 2) {
      restore();
      for (let joint = bones.length - 1; joint >= 0; joint -= 1) {
        for (let axis = 0; axis < 3; axis += 1) bones[joint]!.quaternion.multiply(deltaRotation.setFromAxisAngle(axes[axis]!, delta[joint * 3 + axis]! * step * fraction));
        clamp(joint);
      }
      if (!moved()) break;
      const next = residual();
      if (norm(next) < norm(error) - 1e-14) {
        error = next;
        predictedReduction = modelReduction();
        accepted = true;
        break;
      }
    }
    // At a clinical boundary the central, clipped Jacobian can combine half
    // steps into an unavailable outward direction. Its feasible one-sided
    // rotations span the local constraint cone; nonnegative coefficients keep
    // this alternative step inside that cone. Compare actual projected cost,
    // preserving the ordinary DLS step whenever it is better.
    if (atBoundary) {
      const acceptedPose = accepted ? bones.map(bone => bone.quaternion.clone()) : null;
      const coefficients = nonnegativeLeastSquares(feasibleColumns, errorBefore, damping);
      const turns = before.flatMap((_, joint) => [0, 1, 2].map(axis => coefficients.reduce(
        (sum, coefficient, index) => sum + coefficient * feasibleRotations[index]![joint * 3 + axis]!, 0)));
      const feasibleStep = Math.min(1, .2 / Math.max(...turns.map(Math.abs), 1e-9));
      let bestError = error;
      let bestPose = acceptedPose;
      let bestPrediction = predictedReduction;
      for (let fraction = 1; fraction > Number.EPSILON; fraction /= 2) {
        restore();
        for (let joint = bones.length - 1; joint >= 0; joint -= 1) {
          const turn = new THREE.Vector3(turns[joint * 3]!, turns[joint * 3 + 1]!, turns[joint * 3 + 2]!);
          const angle = turn.length();
          if (angle > 1e-12) bones[joint]!.quaternion.multiply(deltaRotation.setFromAxisAngle(turn.divideScalar(angle), angle * feasibleStep * fraction));
          clamp(joint);
        }
        if (!moved()) break;
        const next = residual();
        if (norm(next) < norm(bestError) - 1e-14) {
          bestError = next;
          bestPose = bones.map(bone => bone.quaternion.clone());
          bestPrediction = modelReduction();
          break;
        }
      }
      if (bestPose) {
        bones.forEach((bone, index) => bone.quaternion.copy(bestPose[index]!));
        error = bestError;
        predictedReduction = bestPrediction;
        accepted = true;
      }
    }
    if (accepted) {
      // An unreachable target can improve by a tiny fraction of the linear
      // model's prediction. Shrinking damping after every such step caused
      // repeated trust-region cycles and input-sensitive iteration cutoffs.
      // Compare the selected DLS/feasible step with its own model, only after
      // both candidates have used the same damping for this iteration.
      const gain = predictedReduction > 0 ? (costBefore - norm(error)) / predictedReduction : 0;
      if (gain < .25) damping = Math.min(.1, damping * 4);
      else if (gain > .75) damping = Math.max(1e-7, damping / 2);
    } else {
      restore();
      damping *= 10;
      if (damping > .1) { stopReason = 'search-stalled'; break; }
    }
  }
  // Read-only final-state stationarity probes. Every candidate is restored;
  // these do not select a runtime step or alter termination/settings.
  {
    const fixed=bones.map(b=>b.quaternion.clone());
    const restoreFixed=()=>bones.forEach((b,i)=>b.quaternion.copy(fixed[i]!));
    const projectAll=()=>{for(let i=bones.length-1;i>=0;i--)clamp(i);};
    const baseline=residual(), cost=norm(baseline), primarySize=6+(minimumElbowY!=null?1:0);
    const primary=(e:number[])=>e.slice(0,primarySize).reduce((sum,x)=>sum+x*x,0);
    const turns=()=>bones.flatMap((b,i)=>{const q=fixed[i]!.clone().invert().multiply(b.quaternion).normalize();if(q.w<0)q.set(-q.x,-q.y,-q.z,-q.w);const n=Math.hypot(q.x,q.y,q.z),k=n>1e-12?2*Math.atan2(n,q.w)/n:2;return[q.x*k,q.y*k,q.z*k];});
    const probe:any={guided:!!elbowDirection,hasPrior:!!posturePrior,stopReason,iterations,cost,primaryCost:primary(baseline),secondaryCost:cost-primary(baseline),derivatives:[],gauge:[]};
    for(const radius of[.001,.00001]){
      const columns:number[][]=[],directions:{label:string,turns:number[]}[]=[];
      for(let joint=0;joint<bones.length;joint++)for(let axis=0;axis<3;axis++){
        restoreFixed();bones[joint]!.quaternion.multiply(deltaRotation.setFromAxisAngle(axes[axis]!,radius));const plus=residual();projectAll();directions.push({label:canonicalKeys[joint]+' axis'+axis+'+',turns:turns()});
        restoreFixed();bones[joint]!.quaternion.multiply(deltaRotation.setFromAxisAngle(axes[axis]!,-radius));const minus=residual();projectAll();directions.push({label:canonicalKeys[joint]+' axis'+axis+'-',turns:turns()});
        columns.push(plus.map((v,i)=>(v-minus[i]!)/(2*radius)));
      }
      const gradient=columns.map(c=>2*c.reduce((sum,v,i)=>sum+v*baseline[i]!,0));
      const cone=directions.map(d=>{const length=Math.hypot(...d.turns);return{label:d.label,turnNorm:length,directionalDerivative:length>1e-12?gradient.reduce((sum,g,i)=>sum+g*d.turns[i]!,0)/length:null};});
      let best:any={improvement:0};
      const evaluateTurns=(direction:number[],magnitude:number,label:string)=>{
        const length=Math.hypot(...direction);if(length<1e-12)return;
        restoreFixed();for(let j=bones.length-1;j>=0;j--){const v=new THREE.Vector3(...direction.slice(j*3,j*3+3) as[number,number,number]).multiplyScalar(magnitude/length);const n=v.length();if(n)bones[j]!.quaternion.multiply(deltaRotation.setFromAxisAngle(v.divideScalar(n),n));}
        projectAll();const e=residual(),improvement=cost-norm(e);
        if(improvement>best.improvement)best={improvement,cost:norm(e),primaryImprovement:primary(baseline)-primary(e),secondaryImprovement:(cost-primary(baseline))-(norm(e)-primary(e)),magnitude,label,actualTurnNorm:Math.hypot(...turns())};
      };
      for(const magnitude of[.001,.0001,.00001,.000001]){
        evaluateTurns(gradient.map(g=>-g),magnitude,'negative raw gradient projected');
        for(const direction of directions)evaluateTurns(direction.turns,magnitude,direction.label);
      }
      probe.derivatives.push({radius,gradient,gradientNorm:Math.hypot(...gradient),minimumFeasibleDirectionalDerivative:Math.min(...cone.filter(x=>x.directionalDerivative!=null).map(x=>x.directionalDerivative!)),cone,bestIndependentStep:best});
    }
    if(hand.parent===bones[1]&&hand.position.lengthSq()>1e-12)for(const angle of[-.001,-.0001,-.00001,.00001,.0001,.001]){
      restoreFixed();const q=new THREE.Quaternion().setFromAxisAngle(hand.position.clone().normalize(),angle);bones[1]!.quaternion.multiply(q);hand.quaternion.premultiply(q.invert());
      const raw=residual();projectAll();const projected=residual();probe.gauge.push({angle,rawPrimaryDifference:primary(raw)-primary(baseline),rawSecondaryDifference:(norm(raw)-primary(raw))-(cost-primary(baseline)),projectedCostDifference:norm(projected)-cost,projectedPrimaryDifference:primary(projected)-primary(baseline),projectedTurnNorm:Math.hypot(...turns())});
    }
    restoreFixed();root.updateWorldMatrix(true,true);
    ((globalThis as any).__stationarityAudit??=[]).push(probe);
  }
  root.updateWorldMatrix(true, true);
  const result: HandContactSolveResult = {
    stopReason, iterations, objectiveCost: norm(error),
    positionErrorM: Math.hypot(error[0]!, error[1]!, error[2]!),
    orientationErrorRadians: Math.hypot(error[3]!, error[4]!, error[5]!) / angularScale,
  };
  // Finish near the bounded branch prepared above. Raw authored FK priors
  // can oppose a planted palm; experimental hierarchy changes remain offline
  // until both contact and constrained-path stability are demonstrated.
  if (elbowDirection) result.refinement = solveHandContactPoseCore(solver, position, orientation, rest, constraints, undefined, minimumElbowY,
    undefined, posturePrior ? bones.map(bone => bone.quaternion.clone()) : undefined);
  return result;
}

/** Active-set nonnegative ridge least squares for a small feasible tangent cone.
 * Coefficients are joint radians, with the same damping as the ordinary DLS.
 * Bounds constrain directions only; they never replace the clinical projection. */
function nonnegativeLeastSquares(columns: number[][], error: number[], damping: number): number[] {
  const count = columns.length;
  const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);
  const gram = columns.map((a, row) => columns.map((b, col) => dot(a, b) + (row === col ? damping : 0)));
  const rhs = columns.map(column => -dot(column, error));
  const x = Array<number>(count).fill(0), passive = new Set<number>();
  for (let outer = 0; outer < count * 2; outer += 1) {
    let entering = -1, improvement = 1e-12;
    for (let index = 0; index < count; index += 1) if (!passive.has(index)) {
      const gradient = rhs[index]! - dot(gram[index]!, x);
      if (gradient > improvement) { entering = index; improvement = gradient; }
    }
    if (entering < 0) break;
    passive.add(entering);
    for (let inner = 0; inner <= count; inner += 1) {
      const active = [...passive];
      const matrix = active.map(row => [...active.map(col => gram[row]![col]!), rhs[row]!]);
      for (let pivot = 0; pivot < active.length; pivot += 1) {
        let best = pivot;
        for (let row = pivot + 1; row < active.length; row += 1) if (Math.abs(matrix[row]![pivot]!) > Math.abs(matrix[best]![pivot]!)) best = row;
        [matrix[pivot], matrix[best]] = [matrix[best]!, matrix[pivot]!];
        const divisor = matrix[pivot]![pivot]!;
        for (let col = pivot; col <= active.length; col += 1) matrix[pivot]![col] /= divisor;
        for (let row = 0; row < active.length; row += 1) if (row !== pivot) {
          const factor = matrix[row]![pivot]!;
          for (let col = pivot; col <= active.length; col += 1) matrix[row]![col] -= factor * matrix[pivot]![col]!;
        }
      }
      const next = Array<number>(count).fill(0);
      active.forEach((index, row) => { next[index] = matrix[row]![active.length]!; });
      if (active.every(index => next[index]! > 0)) { x.splice(0, count, ...next); break; }
      let fraction = 1;
      for (const index of active) if (next[index]! <= 0) fraction = Math.min(fraction, x[index]! / (x[index]! - next[index]!));
      for (let index = 0; index < count; index += 1) x[index] += fraction * (next[index]! - x[index]!);
      for (const index of active) if (x[index]! <= 1e-12) { x[index] = 0; passive.delete(index); }
    }
  }
  return x;
}

/** Use an isolated transform graph where the standard rig permits it. Custom
 * rigs retain the original live-node solver. The numerical objective, projection
 * and termination are identical in both paths; only solved rotations commit. */
export function solveHandContactPose(...args: Parameters<typeof solveHandContactPoseCore>): ReturnType<typeof solveHandContactPoseCore> {
  const solver = args[0];
  const graph = args[3] && solver.distalCtx ? createHandContactCalculationGraph(solver.ctx.bones, solver.ctx.canonicalKeys) : null;
  if (!graph) return solveHandContactPoseCore(...args);
  const mapping = new Map(graph.actualBones.map((bone, index) => [bone, graph.bones[index]!]));
  args[0] = { ...solver, ctx: { ...solver.ctx, bones: graph.bones },
    distalCtx: solver.distalCtx ? { ...solver.distalCtx, bones: solver.distalCtx.bones.map(bone => mapping.get(bone) ?? bone) } : undefined };
  const result = solveHandContactPoseCore(...args);
  graph.commitQuaternions();
  return result;
}
