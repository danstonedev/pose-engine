# Design Benchmark & Red-Team — 3D-Animation Craft + Biomechanics (OpenSim)

**Date:** 2026-07-21 · **Method:** three research tracers — the 3D-animation + AI-motion frontier, the
biomechanics/OpenSim literature, and a file-level map of both repos — synthesized into a benchmarked
assessment, a quantitative target-set, and an architecture direction. Every external claim carries a source
URL; every internal claim carries a `file:line` or a named test.

Companion to `animation-realism-audit.md`, `improvement-roadmap.md`, `pipeline-diagnostics.md`,
`movement-realism-assessment.md`.

## Why this exists

As the engine grew (six realism waves + a five-stage pipeline remediation), it began to *feel* like it was
drifting from a principled "AI-generated / AI-directed motor-program" foundation into an accumulating pile of
special-case realism transforms. This red-team asks three questions and answers them with outside standards:
is that drift a problem or is it fine? are we using the 3D-animation industry and biomechanics research to
drive the design? and what are the solid, measurable targets for the product as a whole?

## 1. Where we sit in the field (and why it's the right place)

The motion-generation field splits cleanly in two:

- **Kinematic pose-space generators** — author or parameterize pose trajectories directly. Controllable,
  editable, deterministic, physics-blind. **This engine lives here.**
- **Physics-based RL controllers** — a torque-actuated character in a physics sim, trained to imitate or
  achieve tasks: DeepMimic → AMP → **ASE** (reusable low-dimensional *skill latent space*) → CALM → PHC →
  **MaskedMimic** (one controller, motion inpainted from partial keyframes/text/objects). This lineage *is*
  the literal "AI-directed motor-program infrastructure": a reusable skill space driven by a high-level
  policy, motion emerging from actuated physics.

Both the animation-research surveys and the biomechanics/clinical literature independently reach the same
verdict for a product like ours: **for a deterministic clinical/education tool, the kinematic camp is the
correct architectural choice — not a compromise.** The RL frontier buys physical plausibility and
perturbation recovery by paying in **non-determinism, non-auditability, and loss of exact clinical control** —
the three properties a tool that must show the *same* clinically-vetted movement every time cannot spend.
Kinematic models are "easy to control and edit" but "prone to physically-invalid artifacts (jitter,
foot-skid, penetration)"; physics controllers are physically valid but stochastic and sim-dependent
(survey: <https://arxiv.org/pdf/2110.06901>, metrics/split survey: <https://arxiv.org/pdf/2503.12763>).

**Conclusion.** The drift away from an autonomous "AI-directed motor program" is *fine — by design.* The
honest, in-charter version of that ambition is a **directable library of reusable, typed, ROM-clamped motion
primitives the LLM parameterizes, plus measured validity gates.** We are most of the way there without the
name; naming it is the spine of the recommendations below.

### The frontier, honestly (what each camp buys and costs)

| Camp | Exemplars | Buys | Costs (for *this* product) |
|---|---|---|---|
| Kinematic authored/parameterized | our engine; Cascadeur (physics-*assist*) | Determinism, ROM guarantees, editability, auditability | Physics-blind unless gated; composition is hand-rolled |
| Kinematic learned (text/LLM→pose) | MDM, MotionDiffuse, T2M-GPT, **MotionGPT**, **OmniControl**, Robust In-betweening | Controllable generation, sparse-constraint direction | Jitter/foot-skate/penetration; needs plausibility cleanup |
| Physics RL controllers | DeepMimic, AMP, **ASE**, CALM, PHC, **MaskedMimic** | Hard physical validity, perturbation recovery, reusable skill latent | **Non-deterministic, non-auditable, hard to exactly control** |

Sources: MotionGPT <https://proceedings.neurips.cc/paper_files/paper/2023/file/3fbf0c1ea0716c03dea93bb6be78dd6f-Paper-Conference.pdf> ·
OmniControl <https://arxiv.org/abs/2310.08580> · MDM <https://arxiv.org/abs/2209.14916> ·
DeepMimic <https://xbpeng.github.io/projects/DeepMimic/index.html> · AMP <https://arxiv.org/abs/2104.02180> ·
ASE <https://xbpeng.github.io/projects/ASE/index.html> · PHC <https://arxiv.org/abs/2305.06456> ·
MaskedMimic <https://xbpeng.github.io/projects/MaskedMimic/index.html> ·
Cascadeur (physics-assist at author time) <https://cascadeur.com/>.

## 2. The three gaps the outside standards flag

The complexity is real and localizable — not vague. `resolveComposedMotion` is a **14-stage funnel**
(`src/services/motionSequence.ts:1661-2226`) gating **~15 optional realism flags** (`:346-519`), each backed
by its **own hand-tuned constant table** (`balanceCoordination.ts:95-111` — comment: "RIG-CALIBRATED, not
analytic"; `gaitEnrichment.ts:63-110`; plus `liveliness.ts`, `eyeGaze.ts`, `rootMotion.ts`). The
`pipeline-diagnostics.md` catalog is the proof of the failure mode: the SEAM-*/DET-*/AI-* bugs were almost
never bad joint math — they were **handoff / lockstep / retune desyncs** between independently-tuned layers.
That is the signature of many transforms with no unifying spine.

**Gap 1 — No unified plausibility/validity gate.** The animation industry turns "the 12 Principles" into
*measured* pass/fail: **foot-skating ratio** (slide > ~2.5 cm while foot height < ~5 cm), CoM-in-support,
penetration, seam-jerk (metrics survey <https://arxiv.org/pdf/2503.12763>; foot-skate cleanup
<https://graphics.cs.wisc.edu/Papers/2002/KSG02/cleanup.pdf>). We have scattered rig thresholds and
`simmove/src/kinematicGrade.ts` (teleport/floor/flat-timing, rig-free) but no single auditable gate. **Cheapest,
highest-value, fully in-charter upgrade** — and "every motion passes an auditable validity gate" is a genuine
clinical differentiator.

**Gap 2 — The transform swarm has no spine.** 15 flags × N constant tables × a structural lockstep hazard
(every transform must apply byte-identically in the offline sampler *and* the live stage — a convention, not
a type-enforced invariant). This is precisely the "getting further from a principled foundation" feeling.

**Gap 3 — The AI path emits the wrong abstraction.** It emits *raw keyframe transforms*, which structurally
cannot express the gait plumbing, so R3 coerces it back onto the deterministic machinery after the fact
(`gaitEnrichment.ts` re-anchoring off `looksLikeGaitPlan`). Elegant retrofit — but AI motion has **no native
realism**; its quality is entirely borrowed. The frontier's answer (MotionGPT tokens, OmniControl spatial
constraints, MaskedMimic inpainting) is that the model **directs a reusable primitive library under sparse
constraints** and the machinery fills in — the natural evolution of our compose path, and the deterministic
version of the "motor program" idea.

## 3. The whole-product target-set (what "solid targets" means)

OpenSim's *dynamic* ground truth — marker RMS < 2 cm, residual-force reduction, muscle activations vs EMG
(IK best-practices <https://opensimconfluence.atlassian.net/wiki/spaces/OpenSim/pages/53090489/>; Rajagopal
model within 3% RMSE of ID moments <https://pmc.ncbi.nlm.nih.gov/articles/PMC5507211/>) — is **out of
charter**: we have no forces, muscles, or inverse dynamics and must never claim them. Its **kinematic** ground
truth is fair game, and we already approximate 6 of 11 targets.

| # | Target (normative literature) | Status today |
|---|---|---|
| 1 | Knee sagittal: ~0° IC, 15–20° loading wave, **peak swing 60–65° ±5°** | ✅ approximated (joint-angle rig gates) |
| 2 | Hip sagittal: ~30° flex IC → ~10° ext terminal stance (**~40° arc**) | ✅ approximated |
| 3 | Ankle sagittal: neutral IC, ~10° DF terminal stance, 15–25° PF toe-off (**~30° arc**) | ✅ approximated |
| 4 | Phase timing: stance **60–62%** / swing 38–40%; two double-support ~10–12% windows | ✅ `gaitPerryTiming.test.ts` |
| 5 | Spatiotemporal: 1.2–1.4 m/s, cadence ~110, stride 1.3–1.5 m, step width 8–17 cm, **walk-ratio ≈ const** | ⚠️ partial |
| 6 | Vertical pelvis/CoM excursion **4–5 cm** at normal speed | ✅ `NORMAL_GAIT_VERTICAL_CM=5` + gate |
| 7 | Pelvic obliquity ≤ ~6° normal (exceeded in Trendelenburg) | ⚠️ needs pelvic-list DOF or an honest caveat |
| 8 | Foot-slide ≈ 0 (sub-cm) during stance | ✅ `gaitTravel.test.ts`, `FOOT_ROOT_DRIFT_M` |
| 9 | ROM clamps = AAOS arcs (hip 0–120/0–30, knee 0–135, ankle DF 0–20 / PF 0–50) | ✅ `romRegistry.ts` |
| 10 | **Froude number ≈ 0.25** for comfortable authored walk (dimensionless-speed sanity) | ❌ new gate |
| 11 | **GDI-lite deviation score** vs own normal curve → faults *quantified*, not just visually different | ⚠️ faults exist, unscored |
| — | Dynamic consistency, GRF, joint moments, muscle activation, EMG | **OUT of charter — never claim** |

Normative sources: Perry gait phases & 60/40 split <https://now.aapmr.org/biomechanics-normal-gait/> ·
sagittal joint curves <https://podiapaedia.org/wiki/biomechanics/gait/angular-kinematics-of-gait/> ·
spatiotemporal norms <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10730124/> · vertical/ML CoM excursion
<https://pubmed.ncbi.nlm.nih.gov/15685471/> · AAOS ROM <https://www.physio-pedia.com/Range_of_Motion_Normative_Values> ·
Froude for walking <https://pubmed.ncbi.nlm.nih.gov/25455435/> · GDI (Schwartz & Rozumalski 2008)
<https://pubmed.ncbi.nlm.nih.gov/18565753/>.

**Animation-craft plausibility gates (in-charter):** foot-skating ratio, CoM-inside-base-of-support (reuse
`src/services/centerOfMass.ts` + `balanceCoordination.ts` `computeBalanceState`/MoS), self/floor penetration,
seam jerk / velocity-discontinuity, ROM-clamp violation. `simmove/src/kinematicGrade.ts` is the seed to
generalize.

**Clinical fault signatures (quantify each fault as a delta from the normal curve):** Trendelenburg = pelvic
obliquity beyond ~6° + trunk lean (<https://www.ncbi.nlm.nih.gov/books/NBK541094/>); antalgic = shortened
stance %; circumduction = abducted semicircular swing path; steppage = elevated swing hip/knee flexion;
crouch = sustained stance-phase knee flexion. A "GDI-lite" single score against our own normal reference
turns faults from "looks different" into "measurably N SD from normal."

## 4. The product-claims boundary (the "whole product" honesty line)

State it explicitly, everywhere the product describes its realism:

> **We match published normative *kinematics* (joint-angle trajectories, phase timing, spatiotemporal
> parameters, CoM excursion) within ±1 SD. We make *no* dynamic, ground-reaction-force, joint-moment,
> muscle-force, or EMG claims.**

This is the exact line OpenSim's own methodology draws for a kinematics-only tool, and for PT education it is
a *strength*: an auditable correctness guarantee that vague "realistic" competitors cannot make. What the
product **can** assert: normative-kinematic fidelity, ROM-legal motion, quantified clinical deviations. What
it **cannot**: that the motion is dynamically consistent, force-plausible, or muscle-validated.

## 5. Architecture recommendations (the roadmap)

Affirm the charter; build the **deterministic motor-program library**. Four workstreams, shipped in the
established rhythm (rig-gated, full-suite-green, engine PR → submodule bump → simMOVE PR → deploy):

- **Workstream A — Unified build-time Validity Gate (highest ROI; first).** One module, run on every template
  and every AI-composed clip, emitting an auditable pass/fail + score across the animation plausibility gates
  and the biomech targets (joint-angle RMS vs bundled normative curves ±1 SD; Perry timing; spatiotemporal +
  walk-ratio; Froude; obliquity; GDI-lite). Generalizes `kinematicGrade.ts`, folds in the scattered rig
  thresholds, bundles OpenSim/CGA normative curves as data.
- **Workstream B — Motor-program primitive library (the spine).** Collapse the ~15 `ComposedMotion` flags +
  the `movementTemplates.ts` builders into named, typed, ROM-clamped, composable primitives with **one**
  parameter schema and **one** shared constant registry — retiring the parallel hand-tuned tables. This *is*
  the deterministic "motor-program infrastructure." Optional craft upgrade: motion-matching over the
  *authored* corpus + stride/orientation warping + foot IK as deterministic composition ops
  (Motion Matching <https://www.gameanim.com/2016/05/03/motion-matching-ubisofts-honor/>; Learned MM
  <https://theorangeduck.com/media/uploads/other_stuff/Learned_Motion_Matching.pdf>; pose warping
  <https://dev.epicgames.com/documentation/en-us/unreal-engine/pose-warping-in-unreal-engine>).
- **Workstream C — Reframe AI-compose to constraint-directed.** The LLM directs primitives under sparse
  keyframe/goal constraints (OmniControl/MaskedMimic pattern) instead of emitting raw transforms; generalize
  `gaitEnrichment`'s re-anchoring so AI motion inherits realism natively.
- **Workstream D — Deterministic physics-corrector (optional, flagged).** An optimization-based (NOT RL) CoM /
  foot-contact cleanup post-pass, only if plausibility must become automatic. Stays byte-reproducible;
  explicitly an extension beyond "mimic at author time." (Cascadeur and DeepMotion's physics-cleanup pass are
  the shipped precedents.)

## Known rig caveats (call out honestly)

Single Character-Creator skeleton; **feet-only `CONTACT_KEYS`** (`src/services/rootMotion.ts:126`) — multi-
contact postures use posture-scoped arithmetic, not the contact set; **no pelvic-list DOF** (rejected earlier
on Kuo/Gard inverted-pendulum grounds, `movement-realism-assessment.md`). Target #7 (pelvic obliquity) and
some clinical faults therefore need either a new pelvic DOF or an explicit "authored-approximation" caveat —
resolve this before claiming obliquity numbers.

## Bottom line

The engine's identity — a deterministic, ROM-clamped, rig-gated kinematic composer that *mimics* physics at
author time — is the correct foundation for a clinical/education product, and the "drift" from an autonomous
AI motor-program is the right trade, not a mistake. The work that makes it a rigorously-benchmarked *whole
product* is: (A) a unified validity gate that makes plausibility and normative-kinematic fidelity auditable,
(B) a primitive library that gives the transform swarm a spine and becomes the deterministic motor-program
infrastructure, (C) an AI path that *directs* that library rather than emitting raw transforms, and a clearly
stated claims boundary that turns the kinematic scope into a credibility asset.
