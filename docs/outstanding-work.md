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

### 3.6b Head/cervical protraction–retraction — DONE (channel), OPEN (gait authoring)
The channel exists now: `Neck.protraction`, ±20°, commandable and measured.
Commanded == measured across the band, and **orthogonal to `Neck.flexion` in both
directions** — a pure flexion leaks <0.5° of protraction and vice versa, and
commanded together each still reads its own value. Rig-measured, a 20° command
carries the head **1.32 cm anteriorly with 0.00° of pitch change**: a
translation, which is what the motion is.

Built on a new `companion` hook on `SupportedMotionSpec` — a second bone a motion
also writes. The shoulder's `girdle` hook could not serve: it hands a fixed
sibling a *different* motion's share, which is an elevating arm, not a
two-segment curve.

**`Neck.flexion` now splits evenly across both cervical segments** where it used
to hinge entirely at the upper one. That is what makes the pair orthogonal (sum
vs half-difference), and it is also what the pose rig already claimed the `Neck`
handle did — "curves both neck bones". The readout is unchanged, gated.

**Still open: gait authors none of it, deliberately.** Real walking has very
little cervical protraction–retraction excursion — the fore/aft head movement in
gait comes from the trunk, not from the cervical spine wringing against itself.
Authoring an oscillation here would be inventing motion to make a number move.
The channel is for POSTURE (forward-head presentations) and for commanded
assessment, and that is how it shipped.

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

- **5.1** ~~Orphaned Azure staging environments need a Portal cleanup.~~
  **WRONG — corrected by the repo owner, 2026-07-27. There are none.** This
  entry was inferred from the "This Static Web App already has the maximum
  number of staging environments" failures, which were caused by the
  `pull_request` trigger asking Azure for a preview environment the licence does
  not include — not by leftover environments. The deploy job was gated to
  push-to-main, and the `pull_request` trigger has since been removed entirely
  (simmove `.github/workflows/azure-static-web-apps.yml`), so nothing requests a
  preview any more. Nothing to clean up; there never was.

  Kept struck through rather than deleted, because the ledger's own rule is to
  correct in place and say so. Diagnosing a cause from a symptom, without access
  to the system that would confirm it, is worth remembering as a pattern.

---

## 6. Recently closed — kept for context

| PR | What it fixed | The number |
|----|---------------|-----------|
| #114 | The run travelled slower than the walk | 0.59 → **3.61 m/s**, Froude 1.26, DF 0.31 |
| #115 | The engine certified an anatomically impossible humerus as `complied` | 180° all-glenohumeral → **120 GH + 60 scapular** |
| #116 | Pelvic rotation was invisible to its own readout | clamp rewriting an untouched knee **13.29° → 0.0000°** |
| #117 | The pelvis was not commandable; the walk had none | obliquity peak **2.8°**, contralateral **r = 0.994** |
| #120 | Seven channels measured a flat zero through an entire walk | lumbar/thoracic/cervical flexion **0.005/0.022/0.026 → 2.00/1.50/3.49°** p2p; scapular upRotation + tilt **0.000 → 8.8-11.5 / 6.4-8.2°** |
| #121 | Head protraction had no channel at all | 20° command → **1.32 cm** anterior, **0.00°** pitch |
| #122 | The sagittal spine shipped four times too loud | total trunk pitch **11° → 3.5°** p2p |
| #123 | The body passed through itself, and nothing measured volume | walk hand↔thigh **−2.85 → +2.77 cm**; sit-to-stand **−9.21 → −1.3 cm** (contact, not burial) |
| #124 | The head slid fore-and-aft while the neck held it level | head carry **5.34 → 4.03 cm** (floor 2.70); trunk pitch **3.5 → 1.8°** |

### Three reports, one missing gate each time

The sagittal spine has now been damped twice, and both times **every
per-segment band was green while the visible thing was wrong**. That is a
pattern, not a coincidence: a per-part bound cannot catch a defect that lives in
the whole.

| reported | the number that was wrong | why segments missed it |
|---|---|---|
| "excess movement in the whole spine" | trunk pitch **11°** | lumbar + thoracic flex IN PHASE; the eye sees the SUM |
| "cervical protraction/retraction" | head carry **5.34 cm** | a flexing trunk swings the head on a ~0.6 m lever; the neck cancels the PITCH but not the CARRY |

The second is worth stating precisely because the channel named in the report was
innocent: `Neck.protraction` measured **0.013°**. A fore/aft head slide simply
*looks* like protraction. What produced it was the trunk.

**Damping was the right lever and a cervical counter was not**, which is worth
recording because the counter is the intuitive fix. Protraction moves the head
only ~0.066 cm per degree (rig-measured: 20° carries it 1.32 cm), so undoing
2.6 cm of carry would need ~40° against a ±20° band — and it would do it by
ADDING the very cervical motion the report asked to quiet.

There is a floor this authoring does not own: with the sagittal spine off
entirely the walk still carries the head **2.70 cm** and the run **3.97 cm**,
from pelvic tilt and the run's trunk lean. Both gates are bounded per gait
against those floors rather than pretending to a single number.

The "unless there is a lot of fatigue" behaviour already existed and needed
nothing new: `headStab` releases with locomotor intensity
(`HEADSTAB_ENERGY_RELAX`, floored at 85%), so the neck under-cancels as the gait
gets harder — gaze stabilisation being the first thing a tiring walker loses.

### The class of defect nothing was measuring

Reported from the deployed build: *"the model's fingers/hands are now moving
through the model's legs during swing."* True, and **not a regression** — the
per-vertex hand↔leg minimum on the travel walk was **0.27 cm before** the
movement-realism work and **0.57 cm after** it. Both are "touching". The work
that got blamed had moved the number slightly the RIGHT way; what changed was
that the spine stopped being distracting.

The reason no gate caught it is the useful part. **Every check in this engine
measured angles, timing or the floor — none measured VOLUME.** A pose can sit
inside every ROM band, correctly phased and properly grounded, while the hand
occupies the same cubic centimetres as the thigh. Joint-space validity and
volumetric validity are different claims and only the first was being made.

Worse, a green test was *enforcing* the defect. `stsArmStrategy` asserted the
seated hand sit within 13 cm of the thigh AXIS and called that "the honest 'hand
on the thigh' metric". The thigh carries 10.3 cm of flesh around that axis and
the hand 7.3 cm, so surfaces merely touch at 17.6 cm — the assertion mandated
4.6 cm of interpenetration, and the template obliged with 20° of adduction and
hands buried **9.2 cm** inside the thighs. The same axis-distance reasoning sat
in `ARM_ADD_BASE`'s comment, justifying the gait's carriage as "visible daylight
at every keyframe".

Fixed with `services/limbClearance` (capsule model, rig-measured radii,
validated against per-vertex ground truth and measured ~3.2 cm conservative) and
a `self-intersection` check in the validity gate. **Never tune limb proximity
against an axis distance.**

Two tiers, because the gate can see geometry but not intent: limbs touching may
be right (hands on thighs in a sit-to-stand) or wrong (a hand through a thigh in
gait), so contact WARNS and only burial FAILS. Motions that must never touch
assert it where the intent is known.

### The one that shipped visibly wrong

The sagittal spine landed at **four times** the amplitude it should have, and
went out. Reported back from the deployed build: *"a LOT of excess movement in
the whole spine with flexion/extension … looks very odd."* It was.

Two compounding errors, and only the second is interesting. The bands were too
generous — the sagittal plane is the one plane a walking trunk is genuinely
STILL in, and its whole excursion is a couple of degrees. But the reason it got
past the gates is that lumbar and thoracic flex **in phase**, so what a viewer
sees is their **SUM**, and every gate measured them **individually**. Each
segment sat inside its own declared band while the trunk pitched ~11°
peak-to-peak twice a stride.

A per-segment bound cannot catch a stacking error. There is a total-trunk gate
now, and it is the tight one.

The other lesson is about where to put a guess. These numbers were labelled
"declared conventions, not findings", which was honest — but a convention should
sit at the **quiet** end of a range it cannot pin down. Guessing high is visibly
wrong; guessing low is merely subtle.

### The one that nearly shipped invisibly

Adding seven channels took the walk's busiest keyframe from 48 targets to 55,
against a `MAX_TARGETS_PER_KEYFRAME` of **48** — and overflow truncates by arrival
order, silently. **33 targets were dropped, every one of them right-side**
(R fingers, R hip abduction, R knee rotation, R ankle inversion), because the
coordinator appends the left limb first.

Nothing reported it. What surfaced was two unrelated hand tests failing with
numbers that read like a measurement bug — a finger at 39° beside a finger at
9e-8. The tell was that **halving the girdle gains changed the failures not at
all**, identical to nine decimal places: a perturbation scales, an amputation
does not. The cap is 58 now (see below), and `gaitTargetBudget` asserts zero
`target-limit` outcomes on walk and run so it can never happen quietly again.

Why 58 and not higher: the registry defines 66 channels, six are readout-only, so
60 are commandable and duplicates collapse on resolve. **A cap of 60+ is
unreachable by any plan**, which would retire the overflow guard into untested
dead code. 58 clears the busiest real keyframe (46 non-hand + the 12-target hand
set) exactly.

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
