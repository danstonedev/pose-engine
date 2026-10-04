export type ScapularGirdleField='protraction'|'scapularTilt'|'upRotation';
export interface ScapularGirdleChannel {
 readonly field:ScapularGirdleField;
 readonly parentAxis:readonly [number,number,number];
 readonly sign:Readonly<Record<'L'|'R',1|-1>>;
 readonly range:Readonly<{min:number;max:number}>;
}
export const SCAPULAR_GIRDLE_PROXY:Readonly<{
 schemaVersion:1;
 id:'production-scapular-girdle-parent-yxz-v1';
 frame:'immediate-source-bone-parent-local';
 eulerOrder:'YXZ';
 channels:readonly ScapularGirdleChannel[];
}>;
export const SCAPULAR_GIRDLE_RANGES:Readonly<Record<ScapularGirdleField,Readonly<{min:number;max:number}>>>;
