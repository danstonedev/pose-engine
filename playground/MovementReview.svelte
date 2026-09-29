<script lang="ts">
  import ExamStage3D from '../src/ExamStage3D.svelte';
  import { BODY_VARIANTS } from '../src/anatomy/bodyVariants';
  import { resolveComposedMotion, type ComposedMotion } from '../src/services/motionSequence';
  import { MOVEMENT_TEMPLATES } from '../src/services/movementTemplates.data';
  import { templateToComposedMotion } from '../src/services/movementTemplateMotion';
  import { buildTravelWalk, buildRun } from '../src/services/movementLocomotion';
  import { buildSitDown, buildStandFromSit } from '../src/services/movementPostures';
  import type { MotionRecording, RecordedFrame } from '../src/services/motionRecording';

  let stage = $state<ExamStage3D>(null!);
  let variant = $state<'male' | 'female' | 'neutral'>('female');
  let posable = $state(false);
  let ready = $state(false);
  let status = $state('Loading');
  let frame = $state<RecordedFrame | null>(null);
  let result = $state('');
  const template = (id: string) => templateToComposedMotion(MOVEMENT_TEMPLATES.find(t => t.id === id)!);
  const pelvis = (motion: string, degrees: number): ComposedMotion => ({
    name: `pelvis-${motion}`, startFrom: 'neutral', stance: 'planted',
    keyframes: [{ durationMs: 1500, holdMs: 500, targets: [{ joint: 'Hips', motion, targetDegrees: degrees }] }],
  });
  const shoulder = (reverse: boolean): ComposedMotion => {
    const targets = [
      { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 120 },
      { joint: 'R_Shoulder', motion: 'scapularTilt', targetDegrees: 10 },
    ];
    return { name: 'shoulder-composition', startFrom: 'neutral', stance: 'planted', keyframes: [{ durationMs: 1500, targets: reverse ? targets.reverse() : targets }] };
  };
  const cases: Record<string, () => ComposedMotion | ComposedMotion[]> = {
    'Pelvis yaw 20°': () => pelvis('rotation', 20),
    'Pelvis tilt 15°': () => pelvis('anteriorTilt', 15),
    'Pelvis obliquity 10°': () => pelvis('lateralTilt', 10),
    'Pelvis sequential 20 to 25': () => [
      pelvis('rotation', 20),
      { ...pelvis('rotation', 25), startFrom: 'current' },
    ],
    'Shoulder arm first': () => shoulder(false),
    'Shoulder girdle first': () => shoulder(true),
    'Forearm rotation': () => template('forearm-rotation'),
    'Shoulder rotation': () => template('shoulder-rotation'),
    'Tibial rotation': () => template('tibial-rotation'),
    Squat: () => template('squat'),
    Hinge: () => template('forward-hip-hinge'),
    'Thigh-assisted rise': () => template('sit-to-stand'),
    'Chair transfer': () => [buildSitDown(), buildStandFromSit()],
    Walk: () => buildTravelWalk(),
    Run: () => buildRun(),
  };
  async function run(name: string) {
    stage.cancelActiveMovement();
    status = `Playing: ${name}`;
    const planned = cases[name]();
    const motions = Array.isArray(planned) ? planned : [planned];
    const steps = [];
    const samples = [];
    let continuation: MotionRecording | null = null;
    for (const [index, motion] of motions.entries()) {
      stage.startRecording({ name: motion.name ?? name, sampleHz: 30, sourceKind: 'composed' });
      const resolved = resolveComposedMotion(motion, BODY_VARIANTS[variant]);
      const outcome = await stage.applyComposedMotion(resolved);
      frame = stage.captureFrame();
      steps.push({ outcome, frame });
      const recording = stage.stopRecording();
      if (index === 1) continuation = recording;
      samples.push(recording?.frames.map(f => ({ tMs: f.tMs, angles: f.angles, root: f.root, worldTracks: f.worldTracks })));
    }
    const outcome = steps.at(-1)!.outcome;
    const continuationSamples = continuation?.frames.map(f => ({
      tMs: f.tMs, pelvis: f.angles.Hips, root: f.root,
      feet: { L_Foot: f.worldTracks?.L_Foot, R_Foot: f.worldTracks?.R_Foot },
    }));
    result = JSON.stringify({ outcome, frame, steps, continuationSamples, samples }, null, 2);
    status = `${outcome.status}: ${name}`;
  }
  function reload() { ready = false; frame = null; result = ''; status = 'Loading'; }
</script>

<svelte:head><link rel="icon" href="data:," /></svelte:head>

<main>
  <h1>Movement regression review</h1>
  <p>Review pelvis support, shoulder composition, rotation setup and playback deformation on the shared stage.</p>
  <div class="settings">
    <label>Model <select bind:value={variant} onchange={reload}><option>female</option><option>male</option><option>neutral</option></select></label>
    <label><input type="checkbox" bind:checked={posable} onchange={reload} /> Show posing controls</label>
    <button disabled={!frame} onclick={() => { if (frame) { stage.showRecordedFrame(frame); status = 'Recorded frame'; } }}>Replay captured frame</button>
    <button disabled={!ready} onclick={() => { frame = stage.captureFrame(); result = JSON.stringify({ frame }, null, 2); }}>Capture current frame</button>
    <button disabled={!ready} onclick={() => { stage.cancelActiveMovement(); status = 'Stopped'; }}>Stop</button>
  </div>
  <div class="cases">{#each Object.keys(cases) as name}<button disabled={!ready} onclick={() => run(name)}>{name}</button>{/each}</div>
  <p role="status">{status}</p>
  {#key `${variant}:${posable}`}
    <ExamStage3D bind:this={stage} {variant} {posable} height="650px" idleLiveliness={0}
      onReport={() => { if (!ready) { ready = true; status = 'Ready'; } }} />
  {/key}
  <details><summary>Measured outcome and captured pose</summary><pre>{result}</pre></details>
</main>

<style>
  :global(body) { margin: 0; background: #10171e; color: #e6eef4; font: 15px system-ui; }
  main { max-width: 1100px; margin: auto; padding: 24px; }
  h1 { font-size: 24px; }
  p { color: #becdd7; }
  .settings, .cases { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 12px 0; }
  button, select { padding: 8px 12px; background: #243c49; color: inherit; border: 1px solid #688793; border-radius: 5px; }
  button { cursor: pointer; }
  button:disabled { opacity: 0.4; cursor: default; }
  pre { max-height: 300px; overflow: auto; font-size: 12px; }
</style>
