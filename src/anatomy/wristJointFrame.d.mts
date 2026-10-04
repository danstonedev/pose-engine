export interface WristJointChannel {
 readonly field:'wristFlexion'|'wristDeviation';
 readonly parentAxis:readonly [number,number,number];
 readonly sign:Readonly<Record<'L'|'R',1|-1>>;
}
export const WRIST_JOINT_FRAME:Readonly<{
 schemaVersion:1;
 id:'production-wrist-parent-yxz-v1';
 frame:'immediate-source-bone-parent-local';
 eulerOrder:'YXZ';
 deviation:WristJointChannel;
 flexion:WristJointChannel;
 channels:readonly WristJointChannel[];
 scope:string;
}>;
