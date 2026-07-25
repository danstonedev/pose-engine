/**
 * DRIVER WIRING (deferred fix #5) — the stage must actually route through
 * services/stageDriver. The model itself is covered by stageDriver.test.ts;
 * these pin the wiring, which no test can exercise (the stage is WebGL + Svelte
 * and cannot be mounted here).
 *
 * The invariant that makes `driver.idle` trustworthy is narrow and easy to
 * break by accident: EVERY write to a driver handle must go through the setter
 * paired with it. A single `activeMotionId = x` slipping back in would leave the
 * driver believing the stage is idle while a clip plays — and the idle gate
 * would then ride idle-liveliness overlays on top of a driven pose. So the
 * no-raw-write rule is machine-checked below rather than trusted to review.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stageSource = readFileSync(
  fileURLToPath(new URL('../ExamStage3D.svelte', import.meta.url)),
  'utf8',
);

/** The four driver handles and the setter each one must be written through. */
const HANDLES: { handle: string; setter: string; mechanism: string }[] = [
  { handle: 'activeMotionId', setter: 'setActiveMotionId', mechanism: 'clip' },
  { handle: 'composedActive', setter: 'setComposedActive', mechanism: 'composed' },
  { handle: 'activeTween', setter: 'setActiveTween', mechanism: 'tween' },
  { handle: 'activeTrajectory', setter: 'setActiveTrajectory', mechanism: 'trajectory' },
];

describe('driver wiring — every handle is written through its paired setter', () => {
  it.each(HANDLES)(
    '$handle registers `$mechanism` with the driver in one place',
    ({ handle, setter, mechanism }) => {
      const on =
        mechanism === 'composed'
          ? 'on'
          : mechanism === 'clip'
            ? 'id !== null'
            : 't !== null';
      expect(stageSource).toMatch(
        new RegExp(
          `function ${setter}\\([^)]*\\)[^{]*\\{[\\s\\S]{0,160}${handle} = [\\s\\S]{0,80}driver\\.setRunning\\('${mechanism}', ${on.replace(/[!]/g, '!')}\\)`,
        ),
      );
    },
  );

  it.each(HANDLES)('NO raw assignment to $handle escapes its setter', ({ handle, setter }) => {
    // Every `<handle> = …` in the file must be either the declaration or the one
    // inside its own setter. Anything else bypasses the driver and silently
    // desynchronises `driver.idle` from reality.
    const lines = stageSource.split('\n');
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!new RegExp(`^\\s+${handle}\\s*=(?!=)`).test(line)) return;
      if (/^\s*let /.test(line)) return; // the declaration
      const before = lines.slice(Math.max(0, i - 6), i).join('\n');
      if (before.includes(`function ${setter}`)) return; // inside its own setter
      offenders.push(`${i + 1}: ${line.trim()}`);
    });
    expect(offenders, `raw ${handle} writes bypassing ${setter}`).toEqual([]);
  });
});

describe('driver wiring — one idle question', () => {
  it('the render loop asks the driver, not four booleans', () => {
    expect(stageSource).toMatch(
      /if \(driver\.idle && !poseLayerBusy\?\.\(\) && applyIdleOverlays\(motionDelta\)\)/,
    );
    // The old spelled-out gate must be gone — if it comes back, a new mechanism
    // can be added without this gate learning about it.
    expect(stageSource).not.toMatch(
      /!activeMotionId &&\s*\n\s*!composedActive &&\s*\n\s*!activeTween &&\s*\n\s*!activeTrajectory/,
    );
  });
});

describe('driver wiring — supersession covers the clip path (fix #4)', () => {
  it('an out-of-band Stop ALWAYS advances the generation', () => {
    // Previously the bump happened only inside cancelComposed(), i.e. only when a
    // composed motion was active — so Stop during a clip load did nothing.
    expect(stageSource).toMatch(
      /composedCancelledToken = composedActiveToken;\s*\n\s*cancelComposed\(\);\s*\n\s*\} else \{[\s\S]{0,700}driver\.supersede\(\);/,
    );
  });

  it('cancelComposed advances the SAME generation (one counter, not two)', () => {
    expect(stageSource).toMatch(/function cancelComposed\(\) \{\s*\n\s*composedSeq = driver\.supersede\(\);/);
  });

  it('runMotionImpl snapshots before the clip await and re-checks after it', () => {
    expect(stageSource).toMatch(
      /const claim = driver\.snapshot\(\);[\s\S]{0,400}await motionClipProvider\.getClips\(motion\)/,
    );
    expect(stageSource).toMatch(
      /await motionClipProvider\.getClips\(motion\)[\s\S]{0,600}if \(!driver\.holds\(claim\)\) \{/,
    );
  });

  it('a superseded load reports it honestly and still caches the clip', () => {
    // Not a failure — nothing went wrong, the command was overtaken. The work is
    // done, so the clip is cached for the next play rather than thrown away.
    expect(stageSource).toMatch(
      /if \(!driver\.holds\(claim\)\) \{[\s\S]{0,700}motionClipCache\.set\(motion,[\s\S]{0,300}return \{ status: 'refused', motion, reason: 'superseded' \};/,
    );
  });

  it('the superseded check runs BEFORE the takeover cascade', () => {
    // If it ran after, the stale clip would already have cancelled the composed
    // motion and reset the root before bailing — a visible pose disturbance from
    // a command that never played. Assert by position rather than by a regex
    // window, so widening the block between them can't quietly break the pin.
    const guard = stageSource.indexOf('if (!driver.holds(claim)) {');
    const takeover = stageSource.indexOf(
      "poseLayerOnTakeover?.();\n        cancelComposed();",
      guard,
    );
    expect(guard, 'the supersession guard exists').toBeGreaterThan(-1);
    expect(takeover, 'the clip takeover cascade follows it').toBeGreaterThan(guard);
  });
});
