import { pathToFileURL } from 'node:url';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// node verify-pressup-host-parity.mjs <host-config.json> <fresh-output> [host|all] [body|all] [scenario|all]
const [configArg, outputArg, hostFilter, variantFilter, scenarioFilter] = process.argv.slice(2);
if (!configArg || !outputArg) throw Error('Host configuration and fresh output directory required');
const configPath = resolve(configArg), configRoot = dirname(configPath);
const configurationBytes = await readFile(configPath);
const configuration = JSON.parse(configurationBytes.toString());
const { chromium } = await import(pathToFileURL(resolve(configRoot, configuration.playwrightModule)).href);
const hosts = configuration.hosts;
assert.ok(hosts && Object.keys(hosts).length, 'At least one host required');
assert.ok(!hostFilter || hostFilter === 'all' || Object.hasOwn(hosts, hostFilter), 'Unknown host filter');
assert.ok(!variantFilter || ['all', 'male', 'female', 'neutral'].includes(variantFilter), 'Unknown body filter');
assert.ok(!scenarioFilter || ['all', 'default', 'patient-feasible', 'patient'].includes(scenarioFilter), 'Unknown scenario filter');
for (const [name, host] of Object.entries(hosts)) {
  assert.ok(host.origin && host.engine && host.sourceRoot, 'Incomplete host configuration: ' + name);
  host.sourceRoot = resolve(configRoot, host.sourceRoot);
}
const output = resolve(outputArg); await mkdir(output);
const identities = async host => {
  const source = pathToFileURL(join(hosts[host].sourceRoot, 'src') + '/');
  const files = (await readdir(source, { recursive: true })).map(name => name.replaceAll('\\', '/'))
    .filter(name => !name.includes('__tests__/') && /\.(?:[cm]?ts|svelte|[cm]?js)$/.test(name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async name => [name,
    createHash('sha256').update(await readFile(new URL(name, source))).digest('hex')])));
};
const result = { scope: 'Real ExamStage3D on each host with controlled performance clock; its public captureFrame compared against an independent rig sampled by that host. Patient constraints supplied only through resolved motion. This is delivery parity, not movement acceptance.', configurationSha256: createHash('sha256').update(configurationBytes).digest('hex'), scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), before: {}, cases: [] };
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  for (const [host, config] of Object.entries(hosts)) {
    if (hostFilter && hostFilter !== 'all' && host !== hostFilter) continue;
    result.before[host] = await identities(host);
    for (const variant of ['male', 'female', 'neutral']) for (const scenario of ['default', 'patient-feasible', 'patient']) {
      if (variantFilter && variantFilter !== 'all' && variant !== variantFilter
        || scenarioFilter && scenarioFilter !== 'all' && scenarioFilter !== scenario) continue;
      const patient = scenario !== 'default';
      const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
      const patientKind = scenario === 'patient-feasible' ? 'restricted-reach' : 'locked-knees-restricted-arms';
      const page = await context.newPage(), row = { host, variant, scenario, patient, ...(patient ? { patientKind } : {}), errors: [], samples: [] }; result.cases.push(row);
      page.on('pageerror', error => row.errors.push(String(error)));
      row.consoleErrors = []; row.failedRequests = [];
      page.on('console', message => { if (message.type() === 'error') row.consoleErrors.push(message.text()); });
      page.on('requestfailed', request => row.failedRequests.push({ url: request.url(), error: request.failure() }));
      await page.route('**/__pressup-stage-parity', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><div id="test"></div></body></html>' }));
      try {
        await page.goto(config.origin + '/__pressup-stage-parity');
        await page.evaluate(async ({ engine, variant, modelResolver }) => {
          const compiledBoot = await (await fetch(`${engine}/src/services/sceneBoot.ts`)).text();
          const loaderUrl = compiledBoot.match(/from ["']([^"']*\/three_examples_jsm_loaders_GLTFLoader__js\.js(?:\?[^"']*)?)["']/)?.[1];
          const decoderUrl = compiledBoot.match(/from ["']([^"']*\/three_examples_jsm_libs_meshopt_decoder__module__js\.js(?:\?[^"']*)?)["']/)?.[1];
          if (!loaderUrl || !decoderUrl) throw Error('Cannot identify the actual stage model dependencies');
          const stageUrl = `${engine}/src/ExamStage3D.svelte`;
          const compiledStage = await (await fetch(stageUrl)).text();
          const svelteUrl = compiledStage.match(/from ["']([^"']*\/svelte\.js(?:\?[^"']*)?)["']/)?.[1];
          if (!svelteUrl) throw Error('Cannot identify the compiled stage Svelte runtime');
          // Vite serves dependency chunks with the requested query. An unversioned
          // mount import creates a second runtime beside the compiled component.
          const [{ mount }, { default: Stage }] = await Promise.all([import(svelteUrl), import(stageUrl)]);
          const modelUrl = modelResolver
            ? variant === 'neutral' ? (await import(`${engine}/models/painmap3D_neutral.runtime.glb?url`)).default
              : (await import(modelResolver)).resolveMannequinModelUrl(variant)
            : `/models/painmap3D_${variant}.runtime.glb`;
          const modelScope = modelResolver && variant === 'neutral'
            ? 'Additional shared-stage neutral rig; the simLAB product selector exposes male/female only.'
            : 'Actual host model URL resolution.';
          const response = await fetch(modelUrl); if (!response.ok) throw Error(`Model fetch failed: ${response.status}`);
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength < 12 || new DataView(bytes).getUint32(0, true) !== 0x46546c67) throw Error('Host model URL did not return a GLB');
          const sourceAssetSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
          window.audit = { ready: false, modelUrl, modelScope, sourceAssetSha256, svelteUrl, loaderUrl, decoderUrl };
          window.audit.stage = mount(Stage, { target: document.querySelector('#test'), props: {
            variant, modelUrl, height: '800px', idleLiveliness: 0,
            sceneLayer: ctx => { window.audit.context = ctx; return { onModelLoaded: () => { window.audit.ready = true; } }; },
          } });
        }, { ...config, variant });
        await page.waitForFunction(() => window.audit?.ready && window.audit.stage.captureFrame(), { timeout: 60000 });
        row.setup = await page.evaluate(async ({ engine, variant, patient, patientKind }) => {
          const a = window.audit, module = path => import(`${engine}/src/${path}.ts`);
          const [{ BODY_VARIANTS }, { applyAnatomicPose }, { serializeCustomPose }, { captureJointAngleRestReference }, { resolveComposedMotion }, { sampleComposedMotion }, { BODY_ASSESSMENT_MOTIONS }] = await Promise.all([
            module('anatomy/bodyVariants'), module('services/anatomicPose'), module('services/poseRig'), module('services/jointAngles'), module('services/motionSequence'), module('services/motionRecording'), module('services/assessmentBodyMotions'),
          ]);
          const { GLTFLoader } = await import(a.loaderUrl);
          const { MeshoptDecoder } = await import(a.decoderUrl);
          const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(a.modelUrl)).scene;
          const cfg = BODY_VARIANTS[variant]; root.scale.copy(a.context.modelRoot.scale); applyAnatomicPose(root, cfg);
          root.position.copy(a.context.modelRoot.position); root.quaternion.copy(a.context.modelRoot.quaternion); root.updateMatrixWorld(true);
          let skinned; root.traverse(node => { if (!skinned && node.isSkinnedMesh) skinned = node; });
          const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
          const liveBaseline = a.stage.captureFrame().pose;
          const baselineDifferencesDeg = Object.fromEntries(Object.entries(baselinePose.bones).map(([key, quat]) => [key,
            new a.context.THREE.Quaternion().fromArray(quat).normalize().angleTo(new a.context.THREE.Quaternion().fromArray(liveBaseline.bones[key]).normalize()) * 180 / Math.PI]));
          const constraints = patient ? Object.fromEntries(['L', 'R'].flatMap(side => [
            [side + '_Forearm', { elbowFlexion: { availableRange: patientKind === 'restricted-reach' ? { min: 10, max: 145 } : { min: 35, max: 75 } } }],
            [side + '_Hand', { wristFlexion: { availableRange: patientKind === 'restricted-reach' ? { min: -65, max: 60 } : { min: -35, max: 35 } } }],
            ...(patientKind === 'restricted-reach' ? [] : [[side + '_Leg', { kneeFlexion: { availableRange: { min: 0, max: 0 } } }]]),
          ])) : null;
          const resolved = resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']('R'), cfg, { constraints });
          const { isRomClampActive } = await module('services/poseRomClamp');
          if (patientKind === 'locked-knees-restricted-arms' && patient) {
            const before = a.stage.captureFrame();
            const recording = sampleComposedMotion(resolved, { baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned } });
            const outcome = await a.stage.applyComposedMotion(resolved);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const after = a.stage.captureFrame();
            const geometry = frame => ({ pose: frame.pose, root: frame.root, worldTracks: frame.worldTracks });
            return { modelUrl: a.modelUrl, modelScope: a.modelScope, sourceAssetSha256: a.sourceAssetSha256,
              poseModeClampEnabled: isRomClampActive(), times: [], expectedRefusal: true,
              resolvedStatus: resolved.status, reason: resolved.reason, outcome,
              recordingFrameCount: recording.frames.length, recordingRefusalReason: recording.refusalReason,
              unchangedStageGeometry: JSON.stringify(geometry(before)) === JSON.stringify(geometry(after)),
              before: geometry(before), after: geometry(after), persistedConstraints: resolved.constraints ?? constraints };
          }
          if (resolved.status !== 'ok') throw Error('Motion refused: ' + resolved.reason);
          a.times = [0, 1000, 1800, 2500, 4100, 4800, 5400];
          const start = performance.now();
          a.expected = sampleComposedMotion(resolved, { baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, frameTimesMs: a.times, sampleHz: 60 });
          const sampleWallMs = performance.now() - start;
          a.realNow = performance.now.bind(performance); a.now = a.realNow(); a.startAt = a.now;
          Object.defineProperty(performance, 'now', { configurable: true, value: () => a.now });
          a.resolved = resolved; a.settled = false;
          const wallStart = a.realNow();
          a.running = a.stage.applyComposedMotion(resolved).then(value => { a.settled = true; a.outcome = value; });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { modelUrl: a.modelUrl, modelScope: a.modelScope, sourceAssetSha256: a.sourceAssetSha256, svelteRuntime: a.svelteUrl, poseModeClampEnabled: isRomClampActive(), sampleWallMs, startupWallMs: a.realNow() - wallStart, times: a.times, persistedConstraints: resolved.constraints ?? null,
            expectedLayout: a.expected.frames[0].pronePalmLayout, baselineDifferencesDeg,
            declaredFlags: { proneSkinSupport: resolved.proneSkinSupport, pronePalmAnchorFit: resolved.pronePalmAnchorFit },
            rootRest: { position: root.position.toArray(), quaternion: root.quaternion.toArray() } };
        }, { ...config, variant, patient, patientKind });
        for (const tMs of row.setup.times) {
          const sample = await page.evaluate(async tMs => {
            const a = window.audit; a.now = a.startAt + tMs;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const actual = a.stage.captureFrame(), expected = a.expected.frames.find(f => f.tMs === tMs);
            const q = a.context.THREE.Quaternion, v = a.context.THREE.Vector3;
            const bones = Object.entries(expected.pose.bones).map(([key, value]) => ({ key,
              differenceDeg: new q().fromArray(value).normalize().angleTo(new q().fromArray(actual.pose.bones[key]).normalize()) * 180 / Math.PI }));
            const tracks = Object.entries(expected.worldTracks).filter(([key]) => actual.worldTracks[key]).map(([key, value]) => ({ key,
              differenceM: new v().fromArray(value).distanceTo(new v().fromArray(actual.worldTracks[key])) }));
            return { tMs, maxBoneDifference: bones.sort((a, b) => b.differenceDeg - a.differenceDeg)[0], maxTrackDifference: tracks.sort((a, b) => b.differenceM - a.differenceM)[0],
              expectedAngles: expected.angles, actualAngles: actual.angles, support: actual.proneSupport, layout: actual.pronePalmLayout,
              rootDifferenceM: new v().fromArray(expected.root.translateM).distanceTo(new v().fromArray(actual.root.translateM)),
              expectedRoot: expected.root, actualRoot: actual.root, settled: a.settled };
          }, tMs);
          row.samples.push(sample);
        }
        await page.screenshot({ path: join(output, `${host}-${variant}-${scenario}.png`) });
        const engineAsset = await readFile(join(config.sourceRoot, `models/painmap3D_${variant}.runtime.glb`));
        row.engineAssetSha256 = createHash('sha256').update(engineAsset).digest('hex');
        assert.equal(row.setup.sourceAssetSha256, row.engineAssetSha256, 'Actual served production asset differs from engine source');
        assert.equal(row.setup.poseModeClampEnabled, false, 'Browser clamp mode unexpectedly enabled');
        if (row.setup.expectedRefusal) {
          assert.equal(row.setup.resolvedStatus, 'refused', 'Known incompatible endpoint must be refused');
          assert.equal(row.setup.outcome.status, 'refused', 'Live stage must retain refusal');
          assert.equal(row.setup.outcome.reason, row.setup.reason, 'Live refusal reason');
          assert.equal(row.setup.recordingFrameCount, 0, 'Refused recording must have no motion frames');
          assert.equal(row.setup.recordingRefusalReason, row.setup.reason, 'Recording refusal reason');
          assert.equal(row.setup.unchangedStageGeometry, true, 'Refusal must preserve the original stage pose');
        }
        // Preserve the independent patient-bound result even if delivery parity
        // later fails. Include locked knees and both sampled/live measurements.
        if (patient) {
          row.patientBoundViolations = row.samples.flatMap(sample => Object.entries(row.setup.persistedConstraints).flatMap(([joint, fields]) =>
            Object.entries(fields).flatMap(([field, constraint]) => ['expectedAngles', 'actualAngles'].flatMap(source => {
              const value = sample[source]?.[joint]?.[field], range = constraint.availableRange;
              return Number.isFinite(value) && value >= range.min - .05 && value <= range.max + .05 ? []
                : [{ tMs: sample.tMs, source, joint, field, value, range }];
            }))));
        }
        for (const sample of row.samples) {
          assert.ok(sample.maxTrackDifference.differenceM < .0001, `${host}/${variant}/${patient} track parity at${sample.tMs}: ${JSON.stringify(sample.maxTrackDifference)}`);
          assert.ok(sample.maxBoneDifference.differenceDeg < .01, `${host}/${variant}/${patient} bone parity at${sample.tMs}: ${JSON.stringify(sample.maxBoneDifference)}`);
        }
        if (patient) assert.deepEqual(row.patientBoundViolations, [], 'persisted patient bounds');
        assert.equal(row.errors.length, 0, 'Browser errors'); row.pass = true;
      } catch (error) {
        row.failure = String(error); row.pass = false; process.exitCode = 1;
        row.failureState = await page.evaluate(() => ({ ready: window.audit?.ready,
          sceneContext: !!window.audit?.context, modelRoot: !!window.audit?.context?.modelRoot,
          svelteRuntime: window.audit?.svelteUrl, text: document.body.innerText.slice(0, 1200) })).catch(() => null);
        await page.screenshot({ path: join(output, `${host}-${variant}-${scenario}-failure.png`) });
      }
      console.log(JSON.stringify({ host, variant, scenario, patient, pass: row.pass, failure: row.failure, startupWallMs: row.setup?.startupWallMs }));
      await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2)); await context.close();
    }
  }
} finally {
  await browser.close(); result.after = Object.fromEntries(await Promise.all(Object.keys(result.before).map(async host => [host, await identities(host)])));
  result.runtimeStable = JSON.stringify(result.before) === JSON.stringify(result.after);
  const hostIdentities = Object.values(result.before).map(value => JSON.stringify(value));
  result.sharedRuntimeMatches = hostIdentities.every(value => value === hostIdentities[0]);
  if (!result.cases.length || !result.runtimeStable || !result.sharedRuntimeMatches) process.exitCode = 1;
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2));
}
