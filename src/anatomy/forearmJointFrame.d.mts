export interface ForearmJointChannel {
 readonly field:'elbowFlexion'|'forearmRotation';
 readonly restAxis:readonly [number,number,number];
 readonly sign:Readonly<Record<'L'|'R',1|-1>>;
}
export const FOREARM_JOINT_FRAME:Readonly<{
 schemaVersion:1;
 id:'production-forearm-rest-flexion-twist-v1';
 frame:'source-bone-rest-local';
 flexion:ForearmJointChannel;
 rotation:ForearmJointChannel;
 channels:readonly ForearmJointChannel[];
 scope:string;
}>;
