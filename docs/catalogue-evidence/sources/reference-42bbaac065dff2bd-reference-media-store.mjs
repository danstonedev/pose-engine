// @ts-nocheck
import { REFERENCE_MEDIA_MAX_BYTES, referenceMediaKind, validateReferenceAsset } from './reference-media-contract.mjs';

const databaseName = 'simmove-reference-media-v1', storeName = 'assets';
function openDatabase() {
  return new Promise((resolve,reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Local reference storage is unavailable in this browser.')); return; }
    const request = indexedDB.open(databaseName,1);
    let abandoned = false;
    request.onupgradeneeded = () => request.result.createObjectStore(storeName,{keyPath:'sha256'});
    request.onerror = () => reject(new Error('Could not open local reference storage.'));
    request.onblocked = () => { abandoned=true; reject(new Error('Close other simMOVE tabs using older reference storage and retry.')); };
    request.onsuccess = () => { if (abandoned) request.result.close(); else resolve(request.result); };
  });
}
async function transaction(mode,run) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve,reject) => {
      const tx = db.transaction(storeName,mode); let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(new Error(tx.error?.name === 'QuotaExceededError' ? 'Local reference storage is full. Choose a smaller source file or free browser storage.' : 'Could not save or read the local reference file.'));
      const request = run(tx.objectStore(storeName));
      request.onsuccess = () => { result=request.result; };
    });
  } finally { db.close(); }
}
/** Deduplicated browser-local source Blob. Movement JSON retains its hash, never raw media. */
export async function putReferenceMedia(file) {
  if (!(file instanceof Blob) || !file.size || file.size > REFERENCE_MEDIA_MAX_BYTES) throw new Error('Choose a nonempty reference file smaller than 100 MB.');
  const kind=referenceMediaKind(file.type);
  if (!globalThis.crypto?.subtle) throw new Error('Reference storage needs HTTPS or a localhost browser origin.');
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())), b=>b.toString(16).padStart(2,'0')).join('');
  const asset={sha256,name:file.name || `reference.${kind === 'image' ? 'png' : 'mp4'}`,mimeType:file.type,size:file.size,kind};
  validateReferenceAsset(asset);
  await transaction('readwrite',store=>store.put({sha256,asset,blob:file}));
  return asset;
}
export async function getReferenceMedia(sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error('Invalid local reference hash.');
  const entry=await transaction('readonly',store=>store.get(sha256));
  if (!entry) return null;
  validateReferenceAsset(entry.asset);
  if (!(entry.blob instanceof Blob) || entry.blob.size !== entry.asset.size || entry.blob.type !== entry.asset.mimeType) throw new Error('The saved local reference file is incomplete. Reattach the source file.');
  return {asset:entry.asset,blob:entry.blob};
}
