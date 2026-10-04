import type {Quaternion,Vector3} from 'three';
export const UPPER_ARM_CLINICAL_RANGES: Readonly<Record<'shoulderFlexion'|'shoulderAbduction'|'shoulderRotation',Readonly<{min:number;max:number}>>>;
export function upperArmWorldAngles(current:Quaternion,rest:Quaternion,direction:Vector3,restDirection:Vector3,mirror:boolean):{flexion:number;abduction:number;rotation:number};
export function segmentLongAxisLocal(start:readonly number[],end:readonly number[],worldQuaternion:readonly number[]):[number,number,number];
