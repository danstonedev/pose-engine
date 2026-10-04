/** Local comparison figure from unmodified actual Blender renders. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from '../../../.review.local/node_modules/playwright/index.mjs';
const [folderArgument] = process.argv.slice(2);
if (!folderArgument) throw Error('Review folder required');
const folder = resolve(folderArgument), renderFolder = resolve(folder, 'renders');
const manifest = JSON.parse(readFileSync(resolve(folder, 'manifest.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const sheets = [];
try {
  for (const variant of ['male', 'female', 'neutral']) for (const view of ['overhead', 'side']) {
    const images = ['reference', 'proposal'].flatMap(treatment => ['setup', 'middle', 'return'].map(phase => {
      const file = `${variant}-trunk-bilateral-${treatment}-${phase}-${view}.png`;
      return { treatment, phase, file, path: resolve(renderFolder, file), sha256: sha(readFileSync(resolve(renderFolder, file))) };
    }));
    const htmlFile = resolve(folder, `${variant}-${view}-comparison.html`), pngFile = resolve(folder, `${variant}-${view}-comparison.png`);
    const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#192025;color:#eef1f3;font:16px system-ui}h1{font-size:24px;margin:14px 18px 3px}p{margin:0 18px 10px}section{display:grid;grid-template-columns:repeat(3,640px);gap:4px;margin:0 12px 14px}h2{grid-column:1/-1;font-size:18px;margin:0}figure{margin:0}img{display:block;width:640px;height:480px}figcaption{padding:5px;background:#2e393f}small{display:block;margin:10px 18px;color:#bdc9cd}</style><h1>Trunk push-up · ${variant} · whole-body ${view}</h1><p>Actual Blender 5.2.2 renders · fixed original palms · unchanged 76° top and clinical bounds</p>${['reference', 'proposal'].map(treatment => `<section><h2>${treatment === 'reference' ? 'Reference: independent arm preparation' : 'Proposal: shared proximal setup branch, bounded primary palm refinement'}</h2>${images.filter(item => item.treatment === treatment).map(item => `<figure><img src="${pathToFileURL(item.path).href}"><figcaption>${item.phase === 'middle' ? 'Top hold · 2.8 s' : item.phase === 'setup' ? 'Setup bottom · 0 s' : 'Returned bottom · 5.6 s'}</figcaption></figure>`).join('')}</section>`).join('')}<small>Isolated authoring candidate. Remaining top girdle differences, thumb rest readout offset, native tracking failures and full delivery qualification remain open.</small>`;
    writeFileSync(htmlFile, html, { flag: 'wx' });
    const page = await browser.newPage({ viewport: { width: 1960, height: 1200 } });
    await page.goto(pathToFileURL(htmlFile).href); await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await page.screenshot({ path: pngFile, fullPage: true }); await page.close();
    sheets.push({ variant, view, html: htmlFile, image: pngFile, imageSha256: sha(readFileSync(pngFile)), sourceImages: images });
  }
} finally { await browser.close(); }
writeFileSync(resolve(folder, 'comparison-sheets.json'), JSON.stringify({ version: 1, sourceDigest: manifest.sourceDigest,
  scope: 'Unmodified Blender render layout only; figures do not establish clinical/native/delivery acceptance.', sheets }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ count: sheets.length, folder }));
