/** Shared representation of the production one-bone scapular-girdle proxy.
 * These are the existing engine fields and bounds, not an isolated SC or AC
 * joint model or patient-calibrated ROM. Ordered axes reproduce parent-local
 * Euler YXZ exactly; a native consumer conjugates them through its rest frame.
 * Motor capacity, tissue/contact parameters and patient constraints live apart.
 */
/** @param {import('./scapularGirdleProxy.mjs').ScapularGirdleField} field
 * @param {[number,number,number]} parentAxis
 * @param {{L:1|-1,R:1|-1}} sign
 * @param {{min:number,max:number}} range */
const channel=(field,parentAxis,sign,range)=>Object.freeze({field,parentAxis:Object.freeze(parentAxis),sign:Object.freeze(sign),range:Object.freeze(range)});
export const SCAPULAR_GIRDLE_PROXY=Object.freeze({
 schemaVersion:1,
 id:'production-scapular-girdle-parent-yxz-v1',
 frame:'immediate-source-bone-parent-local',
 eulerOrder:'YXZ',
 channels:Object.freeze([
  channel('protraction',[0,1,0],{L:-1,R:1},{min:-30,max:30}),
  channel('scapularTilt',[1,0,0],{L:-1,R:-1},{min:-10,max:40}),
  channel('upRotation',[0,0,1],{L:1,R:-1},{min:-5,max:60}),
 ]),
});
export const SCAPULAR_GIRDLE_RANGES=Object.freeze(Object.fromEntries(SCAPULAR_GIRDLE_PROXY.channels.map(channel=>[channel.field,channel.range])));
