# Outstanding work — movement realism

The live ledger for the movement-realism effort. Every entry is something
**measured and reproducible**, not a hunch: each carries the number that makes
it a defect and, where known, the reason it has not been fixed yet.

**Keep this honest.** An item leaves this file when the behaviour changes and a
gate proves it, not when it stops being annoying. If an item turns out to be
wrong, correct it in place and say so — a stale ledger is worse than none.

Status key: **OPEN** · **BLOCKED** (needs a named capability first) · **ASSET**
(needs a rig/model change, not code) · **DONE** (kept briefly for context).

---

## 1. Next up

### 1.1 Jog and sprint as distinct patterns — DONE
Built and gated. `buildRun`/`buildTravelRun` take `pattern: 'jog' | 'run' |
'sprint'` (default `'run'`, so everything shipping is unchanged). Measured at
speed 1, and each **classifies as itself** by duty factor alone:

| pattern | cadence | GCT | flight | DF | step | speed | Froude |
|---------|---------|-----|--------|-----|------|-------|--------|
| jog     | 133.3   | 338 ms | 112 ms | 0.375 | 1.09 m | 2.42 m/s | 0.57 |
| run     | 160.0   | 233 ms | 142 ms | 0.311 | 1.48 m | 3.94 m/s | 1.50 |
| sprint  | 194.6   | 129 ms | 179 ms | 0.209 | 2.60 m | 8.44 m/s | 6.88 |

The sprint reaches its 85-150 ms stance band **only** because its absorb
keyframe is `ballistic`: two `functional` stance keyframes floor at 90 ms each,
i.e. 180 ms, above the entire band. Reverting that one class pushes it to
175 ms and fails the gate — mutation-checked, as is collapsing all three specs
to the run's (which breaks classification and ordering).

Residual: the sprint's 179 ms flight is longer than the ~130 ms of a real
sprint. Reducing it further trades against step length at this amplitude.

### 1.1b Jog/sprint follow-ups — OPEN
- Sprint flight is ~50 ms long (above); wants the arm/trunk authoring a sprint
  actually uses rather than the run's, scaled.
- Nothing exposes the patterns to the app or the command vocabulary yet — they
  are builder options only.

#### Reference: the declared bands
Live in `services/normativeRun.ts` as engine data. Duty factor is the
discriminator because it is dimensionless — no leg-length scaling to get wrong.
Cadence is quoted at the literature 0.90 m leg and must be scaled to the rig's
1.056 m (`scaleCadenceToLeg`) before comparing.

| pattern | duty factor | cadence (spm @ 0.90 m leg) | GCT (ms) | Froude |
|---------|-------------|---------------------------|----------|--------|
| jog     | 0.36–0.46   | 130–160                   | 280–400  | 0.45–0.95 |
| run     | 0.27–0.38   | 150–185                   | 190–290  | 0.8–2.0 |
| sprint  | 0.16–0.28   | 200–270                   | 85–150   | 3.0–8.0 |

Only the walk↔run transition (Froude ≈ 0.45) is a physical discontinuity — it is
where an inverted-pendulum vault stops being completable under gravity. jog|run
and run|sprint are **declared conventions**; the module labels them as such
rather than dressing them up as findings.

### 1.2 Pelvis in the RUN — OPEN
Only the walk has a pelvis. Same three channels, but the run's flight phase
changes the phase signal `hipDiff` and the whole lateral chain will need
re-checking against run energy (which already swings the stance foot 7–11 cm
laterally on its own — see 3.4).

---

## 2. Foot grounding

The walk grounds its feet with a **vertical pin plus a foot-plant IK**, not a
horizontal foot-lock. Two of the items below are limited by that gap, and the
engine flagged it in `gaitModifiers` before any of this work started: *"a bigger
pelvic yaw … drags the planted foot, since the walk grounds the feet with a
vertical pin, not a horizontal foot-lock IK."*

### 2.1 Pelvic obliquity is amplitude-limited — BLOCKED
Measured peak **2.8°** against a **4–6°** normative peak. At the fully
physiologic 3.9° the planted stance foot slid **3.3 cm** (gate 3.0 cm) and the
termination standstill ramp lost a frame of double support (89.6% against a 90%
floor). The diagnostic content is intact at the reduced amplitude — the drop is
contralateral and phase-locked to the swing limb at **r = 0.994** — so this is a
fidelity cap, not a correctness bug.

### 2.2 The travel derivation tracks the ANKLE through the toe roll — OPEN, **not blocked**
**Correction to an earlier grouping in this file:** this was listed as blocked on
foot-lock IK. It is not — it is a derivation change, and it has now been written
and measured. Moved here only because it sits next to the items it interacts
with.

Localised precisely (worst stance slide, per pattern):

| | ankle total | early stance | late stance |
|---|---|---|---|
| jog | 2.91 cm | **0.07 cm** | 2.86 cm |
| run | 3.39 cm | **0.05 cm** | 3.31 cm |
| sprint | 5.08 cm | **0.14 cm** | 4.94 cm |

While the ankle IS the contact point the cancellation is essentially perfect.
Every bit of the error is on the far side of the roll, where the heel lifts and
the real contact has migrated to the forefoot.

**The roll-over model is written, measured, and preserved unlanded** at
`scratchpad/rollover-wip/` (patch + notes). Tracking whichever of ankle/forefoot
is lower *relative to its own rest*:

| | ankle before → after | toe before → after |
|---|---|---|
| walk | 2.62 → 3.16 | 3.20 → 3.87 |
| jog | 2.91 → 4.94 | 3.71 → **3.09** |
| run | 3.39 → 6.30 | 4.54 → **3.33** |
| sprint | 5.08 → 15.12 | 6.87 → **3.84** |

It **works for the run patterns** — the true late-stance contact is held far
better. The ankle moving more is *physically correct*: during heel-off the ankle
genuinely travels forward over a planted forefoot. Two things must happen before
it can land:
1. **The slide gates must measure the CONTACT point, not the ankle**, or the fix
   reads as a regression everywhere.
2. **The walk regresses on both measures** and needs understanding first — most
   likely because a walk's early-stance contact is the HEEL, which sits behind
   the ankle and has no bone in this rig, so "ankle vs toe" is the wrong pair for
   the first half of a walking stance. A three-point model, or gating the
   roll-over to flight gaits only, are the obvious next moves.

### 2.3 `plantStanceFoot` treats the pelvis as the chain root — BLOCKED
Its own docstring says so. A 20° pelvic yaw makes it counter-rotate the model
root by **−20°**, leaving the pelvis at world zero and the whole body turned.
Reached only when `useFootRoot` is true, which excludes `footDrivenTravel`,
looping and travelling motions — **the travel walk and run are clear** — but
in-place planted motions (squat, hip-hinge, sit-to-stand) are exposed the moment
they author a pelvis.

---

## 3. Known-wrong, documented, unfixed

### 3.1 `shoulderAbduction` is unusable near vertical — OPEN
A pure **120° flexion** reports **132° of abduction**. A singularity in the
world-frame decomposition as the humerus approaches vertical (`atan2(s·v.x,
−v.y)` with `v.y → 0`). Flexion itself is exact; only the off-plane field is
wrong. Pre-existing, untouched by the girdle work.

### 3.2 Glenohumeral overdraft reduced, not eliminated — ASSET
The scapulohumeral split took the overdraft at a commanded 180° flexion from
**60° → 20°**, and to **zero at or below 160°**. The residual exists because the
rig has **one clavicle** where anatomy has two joints (sternoclavicular +
acromioclavicular), so `scapularTilt` bands at 40°. Inflating that band would
move the lie rather than remove it.

### 3.3 No shrug — ASSET
Scapular elevation/depression has no field, and on this rig it **cannot** be
independent: a single rigid clavicle makes elevation and upward rotation the
same rotation about the same axis. A separate field would alias `upRotation`.
Needs a scapula bone in the GLB.

### 3.4 `spinalGaitCoordination` swings the stance foot laterally — OPEN
**7–11 cm** at run energy. The foot-plant IK absorbs it to 0.5 cm so shipped
output is fine, but the underlying sway is not physiologic for running — and the
coordinator is shared with the walk, so any change is a two-gait change.

### 3.5 Flight-arc endpoints are hand-measured constants — OPEN
`RUN_TOEOFF_Y_M` / `RUN_TOUCHDOWN_Y_M` are rig-measured at speed 1, so the
planted↔floating seam closes there and leaves a residual at the speed extremes.
The real fix anchors the arc to the grounding solve at sample time.
**`buildJump` and `buildSingleLegHop` carry the same latent defect.**

### 3.6 The run saturates its protraction cap — OPEN
`0.35 × 48° = 16.8°` clipped to the 10° cap, so the girdle flat-tops across two
adjacent keyframes. Small fix, but it changes gait output, so it wants its own
increment and its own re-measure.

### 3.7 Recording `angles` and `pose` disagree — OPEN
On a push-up recording, `angles` reads **7.744°** where `pose` reads **0.000°**
with the bones static. Surfaced and pinned at <8.5 to stop it drifting further;
never diagnosed.

---

## 4. simMOVE app (separate repo)

- **4.1** UX Step 2 leftovers — body variant to the stage edge, `aiNote` split
  (G13), resolver chip (G14), stage verdict glance (G3/G4). Steps 3–7 unstarted.
- **4.2** Open questions Q2–Q6 from the UX plan. Recommendation on record: flip
  Q6 and put the clip loader on the primary surface. No decision yet.

## 5. Not code

- **5.1** Orphaned Azure staging environments need a Portal cleanup. Production
  only — never preview, per the licence constraint.

---

## 6. Recently closed — kept for context

| PR | What it fixed | The number |
|----|---------------|-----------|
| #114 | The run travelled slower than the walk | 0.59 → **3.61 m/s**, Froude 1.26, DF 0.31 |
| #115 | The engine certified an anatomically impossible humerus as `complied` | 180° all-glenohumeral → **120 GH + 60 scapular** |
| #116 | Pelvic rotation was invisible to its own readout | clamp rewriting an untouched knee **13.29° → 0.0000°** |
| #117 | The pelvis was not commandable; the walk had none | obliquity peak **2.8°**, contralateral **r = 0.994** |

### Two process lessons worth keeping

**Whole-file string replaces have burned this branch twice.** Once silently
rewriting `buildJump`'s root knots, once clobbering the identical line inside
`rotateRestReferenceByRoot` during a mutation-check restore — the second shipped
to CI. Use line-indexed or uniquely-anchored edits.

**The full suite can mask a real failure.** That `rotateRestReferenceByRoot`
break passed 1224/1224 in suite order and failed in a single-file run. Run every
test file in isolation before pushing anything that touches shared measurement
machinery:

```sh
for f in src/__tests__/*.test.ts; do
  npx vitest run "$f" 2>&1 | grep -E "Tests  " | tail -1 | grep -q failed && echo "ISOLATED FAIL: $f"
done
```
