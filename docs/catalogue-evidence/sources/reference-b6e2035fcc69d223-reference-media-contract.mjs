// @ts-nocheck
/** Source evidence for an editable estimate, never physical or clinical acceptance. */
import {POSITION_PRESET_IDS} from '../../experiments/lower-body/authored-route-packet.mjs';
const foundations = new Set(POSITION_PRESET_IDS);
const imageTypes = new Set(['image/jpeg','image/png','image/webp','image/gif','image/bmp','image/avif']);
const videoTypes = new Set(['video/mp4','video/webm','video/quicktime','video/ogg']);
export const REFERENCE_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const fail = message => { throw new Error(`Reference media: ${message}`); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export function referenceMediaKind(mimeType) {
  if (imageTypes.has(mimeType)) return 'image';
  if (videoTypes.has(mimeType)) return 'video';
  fail('choose a supported raster image or video (PNG, JPEG, WebP, MP4 or WebM).');
}
export function validateReferenceAsset(asset) {
  if (!object(asset) || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') || !text(asset.name, 255) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > REFERENCE_MEDIA_MAX_BYTES) fail('invalid source asset or file larger than 100 MB.');
  if (referenceMediaKind(asset.mimeType) !== asset.kind) fail('source type does not match its media kind.');
  return asset;
}
function json(value, depth = 0, count = {n:0}) {
  if (++count.n > 5000 || depth > 12) fail('fit report is too complex.');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value === 'string' && value.length <= 10000) return;
  if (Array.isArray(value)) { value.forEach(child => json(child, depth+1,count)); return; }
  if (!object(value)) fail('fit report must contain finite JSON data.');
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__','constructor','prototype'].includes(key)) fail('unsafe report key.');
    json(child,depth+1,count);
  }
}
function landmarks(value) {
  if (!Array.isArray(value) || value.length !== 33) fail('expected 33 source landmarks.');
  for (const p of value) {
    if (!object(p) || !['x','y','z'].every(key => finite(p[key],-100,100))) fail('invalid source landmark coordinates.');
    for (const key of ['visibility','presence']) if (p[key] !== undefined && !finite(p[key],0,1)) fail('invalid landmark confidence.');
  }
}
export function validateMediaReference(value) {
  if (value === undefined || value === null) return;
  if (!object(value) || value.schemaVersion !== 1) fail('unsupported provenance schema.');
  validateReferenceAsset(value.asset);
  if (![value.sourceWidth,value.sourceHeight].every(n => Number.isInteger(n) && n > 0 && n <= 32768)) fail('invalid source dimensions.');
  if (value.asset.kind === 'image' ? value.frameTimeMs !== null : !finite(value.frameTimeMs,0,86400000)) fail('invalid source frame time.');
  if (!Number.isInteger(value.personIndex) || value.personIndex < 0 || value.personIndex > 10) fail('invalid detected person index.');
  const model = value.detector;
  if (!object(model) || !text(model.name,200) || !text(model.version,100) || (model.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(model.sha256))) fail('invalid detector provenance.');
  const options = value.options;
  if (!object(options) || !foundations.has(options.foundationId) || !finite(options.confidenceThreshold,0,1) || typeof options.mirrored !== 'boolean' || typeof options.keepEquipment !== 'boolean') fail('invalid fitting options.');
  if (options.viewMode !== undefined && !['auto','camera-3d','side-right','side-left'].includes(options.viewMode)) fail('invalid reference camera view.');
  if (options.bilateral !== undefined && typeof options.bilateral !== 'boolean') fail('bilateral intent must be a boolean.');
  if (options.supportMode !== undefined && !['foundation','feet'].includes(options.supportMode)) fail('invalid reference support intent.');
  landmarks(value.landmarks); landmarks(value.worldLandmarks);
  if (!object(value.fitReport)) fail('missing fit report.');
  json(value.fitReport);
  if (value.interpolated !== undefined && typeof value.interpolated !== 'boolean') fail('invalid interpolation provenance.');
  json(value);
}
/** @param {{asset:any,frameTimeMs?:number|null,personIndex?:number,model:any,foundationId?:string,confidenceThreshold?:number,mirrored?:boolean,keepEquipment?:boolean,viewMode?:string,bilateral?:boolean,supportMode?:string,report:any,landmarks:any[],worldLandmarks:any[],sourceWidth:number,sourceHeight:number}} input */
export function createMediaReference({asset,frameTimeMs=null,personIndex=0,model,foundationId='standing',confidenceThreshold=.5,mirrored=false,keepEquipment=true,viewMode='auto',bilateral=false,supportMode='foundation',report,landmarks,worldLandmarks,sourceWidth,sourceHeight}) {
  const value = {schemaVersion:1,asset,frameTimeMs,personIndex,detector:model,options:{foundationId,confidenceThreshold,mirrored,keepEquipment,viewMode,bilateral,supportMode},fitReport:report,landmarks,worldLandmarks,sourceWidth,sourceHeight};
  validateMediaReference(value);
  return JSON.parse(JSON.stringify(value));
}
