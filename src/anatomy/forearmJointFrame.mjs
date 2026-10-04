/** Production elbow/forearm command composition: source-rest * flexion-X *
 * signed longitudinal twist. These are the existing rig command coordinates;
 * geometric elbow flexion still includes the rig's small neutral bend.
 * Off-axis elbow play and distributed hand-local twist are separate and are
 * not represented by this two-channel native definition.
 */
const flexion=Object.freeze({field:'elbowFlexion',restAxis:Object.freeze([1,0,0]),sign:Object.freeze({L:1,R:1})});
const rotation=Object.freeze({field:'forearmRotation',restAxis:Object.freeze([0,-1,0]),sign:Object.freeze({L:1,R:-1})});
export const FOREARM_JOINT_FRAME=Object.freeze({
 schemaVersion:1,
 id:'production-forearm-rest-flexion-twist-v1',
 frame:'source-bone-rest-local',
 flexion,rotation,
 channels:Object.freeze([flexion,rotation]),
 scope:'Ordered rig flexion and axial command coordinates only; geometric neutral bend, allowed off-axis elbow play and distributed hand twist remain distinct.',
});
