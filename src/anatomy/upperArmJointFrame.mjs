import {Quaternion,Vector3} from 'three';

/** Existing engine clinical values, now shared by source and native inspection.
 * These projected thorax-relative fields are not independent hinge coordinates. */
export const UPPER_ARM_CLINICAL_RANGES=Object.freeze({
 shoulderFlexion:Object.freeze({min:-60,max:180}),
 shoulderAbduction:Object.freeze({min:-50,max:180}),
 shoulderRotation:Object.freeze({min:-90,max:70}),
});
const DEG=180/Math.PI,swing=new Quaternion(),twist=new Quaternion(),inverseRest=new Quaternion();
/** Identical to the original engine readout. Callers must place current and
 * rest directions in the SAME anatomical axes (undo live thorax motion first). */
export function upperArmWorldAngles(curWorldQuat,restWorldQuat,curDir,restDir,mirror){
 const sign=mirror?-1:1;
 const flexOf=v=>Math.atan2(v.z,-v.y)*DEG,abdOf=v=>Math.atan2(sign*v.x,-v.y)*DEG;
 twist.copy(curWorldQuat).multiply(inverseRest.copy(restWorldQuat).invert());
 swing.setFromUnitVectors(restDir,curDir);twist.premultiply(swing.invert());
 const length=Math.hypot(twist.x,twist.y,twist.z);
 let angle=length<1e-9?0:2*Math.atan2(length,twist.w);if(angle>Math.PI)angle-=2*Math.PI;
 const axialSign=Math.sign(twist.x*restDir.x+twist.y*restDir.y+twist.z*restDir.z)||1;
 return {flexion:flexOf(curDir)-flexOf(restDir),abduction:abdOf(curDir)-abdOf(restDir),rotation:angle*axialSign*DEG*sign};
}
/** Actual material long axis from trusted neutral centers, in the proximal
 * segment frame. This is shared geometry, not a nominal bone-local Y axis. */
export function segmentLongAxisLocal(start,end,worldQuaternion){
 if(![...start,...end,...worldQuaternion].every(Number.isFinite)||start.length!==3||end.length!==3||worldQuaternion.length!==4)throw new Error('A calibrated segment needs finite neutral centers and orientation');
 const axis=new Vector3().fromArray(end).sub(new Vector3().fromArray(start));
 if(axis.length()<1e-8)throw new Error('A calibrated segment needs distinct centers');
 return axis.normalize().applyQuaternion(new Quaternion().fromArray(worldQuaternion).normalize().invert()).toArray();
}
