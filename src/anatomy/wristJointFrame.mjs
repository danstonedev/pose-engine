/** Existing production wrist command frame. A native consumer conjugates the
 * immediate source-parent axes through its verified neutral hand frame.
 * With no distributed axial component, parent-local YXZ reduces to X then Z:
 * deviation precedes flexion. This is a representation definition, not a claim
 * that hand-local pronation is an independent anatomical wrist joint.
 */
const deviation=Object.freeze({field:'wristDeviation',parentAxis:Object.freeze([1,0,0]),sign:Object.freeze({L:1,R:1})});
const flexion=Object.freeze({field:'wristFlexion',parentAxis:Object.freeze([0,0,1]),sign:Object.freeze({L:-1,R:1})});
export const WRIST_JOINT_FRAME=Object.freeze({
 schemaVersion:1,
 id:'production-wrist-parent-yxz-v1',
 frame:'immediate-source-bone-parent-local',
 eulerOrder:'YXZ',
 deviation,flexion,
 channels:Object.freeze([deviation,flexion]),
 scope:'Two commanded wrist channels only. The engine also permits distributed hand-local axial twist as part of total forearm pronation/supination; a two-axis physical wrist does not represent that channel.',
});
