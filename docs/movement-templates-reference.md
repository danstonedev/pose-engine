> Current movement requirements, defects, reference coverage and acceptance records live in the [master movement/joint catalogue](MASTER-MOVEMENT-JOINT-CATALOGUE.html). This sheet preserves historical authoring choices. Bibliographic correction does not grant movement or clinical approval.

# Movement Template Reference — SME Verification Sheet

> Historical authoring and reference provenance. Use the
> [master movement-joint catalogue](MASTER-MOVEMENT-JOINT-CATALOGUE.html) for
> current references, defects, work ownership and acceptance; record corrections
> and clinician reviews there. Original values, citations and review instructions
> below are retained as provenance. Their validation claims require scoped
> verification. Reconciliation remains partial; unsigned reviews stay unsigned.

**Purpose.** The composed-motion planner (simMOVE / simLAB) now anchors on a small
library of clinician-authored reference templates for core clinical movements
(`pose-engine/src/services/movementTemplates.ts`). Each template encodes the three
things that make a movement recognizable — **peak joint angles**, **phase timing**,
and **coordination** — so the language model starts from an authored clinical
pattern instead of guessing joint angles from scratch.
## Reference audit — 3 October 2026

**Scope.** Correct the squat citation and distinguish the claims supported by the squat, functional-shoulder and chair-rise papers from authoring assumptions. Runtime targets, timing, contact behavior and tolerances were not changed. The original sheet is retained verbatim in [the correction evidence](catalogue-evidence/sources/template-reference-correction-2026-10-03/original-movement-templates-reference.md); its unsupported statements remain traceable below.

**Read the tables below as historical authored settings, not as a current runtime inventory or population norms.** The current squat and sit-to-stand recipes have since changed. ROM clamps and rig round trips test consistency with configured limits and measurements; they do not establish source validity, natural coordination, task equivalence or clinical acceptance. The earlier claims of “every authored value” being literature-validated, “22 tests green,” and a guaranteed ±6° round trip are historical reports without a current scoped test record in this sheet.

### Squat: corrected primary citation and extracted scope

Zawadka M, Smolka J, Skublewska-Paszkowska M, Lukasik E, Gawda P. **How Are Squat Timing and Kinematics in The Sagittal Plane Related to Squat Depth?** *J Sports Sci Med.* 2020;19(3):500–507. PMID 32874102; PMCID PMC7429430. [Primary full text, Methods and Table 2](https://pmc.ncbi.nlm.nih.gov/articles/PMC7429430/).

The study included 20 women and 40 men, healthy recreationally active young adults. It examined unloaded maximal-depth squats, arms forward, heel contact, preferred pace and a 3 s bottom hold. Table 2 reports **ROM excursions**, mean ± SD in degrees:

| Region | Female group | Male group |
|---|---|---|
| Hip | 98.61 ± 12.22° | 99.58 ± 11.03° |
| Knee | 119.00 ± 15.10° | 124.80 ± 15.50° |
| Ankle | 30.81 ± 4.86° | 30.27 ± 6.36° |
| Lumbar measure | 30.08 ± 14.44° | 43.74 ± 15.31° |

These are group means, not normal-range endpoints or prescribed peaks. The lumbar measure is thorax relative to pelvis; it is not an isolated vertebral/bone target. The paper does not validate overhead/dowel FMS, loaded/bar squats, fixed millisecond timing, or the historical 27° lumbar choice. Coordinate/rig mapping and patient/task applicability remain unverified.

### Shoulder: functional task requirements and variable rhythm

Namdari S, Yagnik G, Ebaugh DD, Nagda S, Ramsey ML, Williams GR Jr, Mehta S. **Defining functional shoulder range of motion for activities of daily living.** *J Shoulder Elbow Surg.* 2012;21(9):1177–1183. DOI [10.1016/j.jse.2011.07.032](https://doi.org/10.1016/j.jse.2011.07.032); [primary abstract, PMID 22047785](https://pubmed.ncbi.nlm.nih.gov/22047785/).

The abstract reports 20 volunteers without shoulder pathology, 40 shoulders and ten tasks from ASES, SST and PSS outcome instruments. Reported functional requirements include flexion **121 ± 6.7°** and abduction **128 ± 7.9°**. They support task-specific functional-ROM context. They do not validate a universal 120° elevation screen, full anatomical ROM, an overhead task, or an exact glenohumeral/scapular split. Full-text task tables and coordinate mapping were not verified in this audit.

McQuade KJ, Smidt GL. **Dynamic scapulohumeral rhythm: the effects of external resistance during elevation of the arm in the scapular plane.** *J Orthop Sports Phys Ther.* 1998;27(2):125–133. DOI [10.2519/jospt.1998.27.2.125](https://doi.org/10.2519/jospt.1998.27.2.125); [primary abstract, PMID 9475136](https://pubmed.ncbi.nlm.nih.gov/9475136/).

The abstract describes 25 normal subjects and passive, active limb-weight and maximal-resistance scapular-plane elevation. Rhythm varied with elevation phase and loading. It does not support the sheet's universal post-30° 2:1 rule or exact 85° GH + 35° scapular allocation at 120°. Those allocations are unverified authoring assumptions. Publisher full text was inaccessible through the browsing tool.

### Sit-to-stand: supported phases, unsupported numerical attribution

Schenkman M, Berger RA, Riley PO, Mann RW, Hodge WA. **Whole-body movements during rising to standing from sitting.** *Phys Ther.* 1990;70(10):638–648; discussion 648–651. DOI [10.1093/ptj/70.10.638](https://doi.org/10.1093/ptj/70.10.638); [primary abstract, PMID 2217543](https://pubmed.ncbi.nlm.nih.gov/2217543/).

The abstract describes nine healthy participants under controlled conditions and four phases: flexion momentum, momentum transfer after seat-off, extension and stabilization. This supports a phase framework. It does not establish the sheet's 95–98° initial knee range, 105° hip target, 12° lumbar target, preserved-lordosis rule or classification of 25° lumbar flexion as faulty. These numerical/diagnostic attributions are **unsupported by the accessed material**, not findings that the paper has been shown to disprove. Publisher full text and its numerical tables were not accessible in this audit.

### Historical authoring decisions and unsupported attributions

The “Was → Now” column records the old sheet's changes; it does not describe new changes or the current shared recipes.

| Movement/value | Historical Was → Now | Original stated basis | Current reference disposition |
|---|---|---|---|
| Squat knee | 115° → 120° | “Kim 2020 deep-squat knee ~119–125°” | Wrong author; the cited source is Zawadka 2020. Table 2 group ROM means do not form a normal range or validate a universal peak. |
| Squat lumbar | 20° → 27° | “Kim 2020 ~30–44° lumbar in real squats” | Wrong author; aggregate lumbar ROM does not justify this bone target or preferred technique. |
| Squat ankle DF | 18° → 20° | “Real deep-squat DF ~30° but engine caps AROM at 20° (binding constraint)” | Historical implementation compromise, not a validated normative target or current recipe cap. |
| Sit-to-stand seated knee | 90° → 95° | “STS initiation knee ~95–98°” | No uniquely identified source/table for this range. |
| Sit-to-stand lean hip | 100° → 105° | “preserves the trunk-to-vertical lean once lumbar reduced” | Authoring rationale, not a measured primary-paper result. |
| Sit-to-stand lean lumbar | 25° → 12° | “Healthy STS leans with the HIPS and preserves lumbar lordosis; 25° modeled a faulty/compensatory pattern (Schenkman)” | Unsupported numerical/diagnostic attribution; accessible Schenkman material supports phases only. |
| Lunge lead hip | 55° → 75° | “55° too shallow for a 90° lead-knee bottom (split-squat literature ~75–90°)” | Exact study, task, table and angle convention missing. |
| March knee | 70° → 80° | “more march-like shank hang” | Authoring choice; no measured source provided. |
| March opposite arm | 25° → 38° | “25° = normal-gait amplitude; an exaggerated march exaggerates the arm” | Authoring choice; unique gait/march source and conditions missing. |
| Thoracic extension | −15° → −10° | “rib-cage-limited to ~8–10° (CT: 8.5°)” | CT paper, measurement definition and population unidentified. |

The former “validated within range” claim also covered squat hip 100°, single-leg stance, cervical rotation 70°/80°, lumbar flexion 55°/extension −20°, thoracic flexion 25°, and full shoulder elevation 160–170°. Those approvals remain unsupported here. The old shoulder 2:1/post-30° rule and 85°/35° split are preserved above as unverified assumptions. A citation's existence and a passing rig test do not validate those values.

### Remaining bibliography and coverage gaps

- Historical book citations: Norkin CC/White DJ, *Measurement of Joint Motion: A Guide to Goniometry*; AAOS, *Joint Motion: Method of Measuring and Recording*; Neumann DA, *Kinesiology of the Musculoskeletal System*. Exact editions, pages, measurement conditions and per-value claims are still missing. No edition or page was inferred.
- Bohannon RW: “sit-to-stand and functional-task norms” did not identify a unique work. No arbitrary Bohannon paper has been substituted.
- Inman/Saunders/Abbott “1944”: [PMID 8804269](https://pubmed.ncbi.nlm.nih.gov/8804269/) identifies a 1996 reprint in *Clin Orthop Relat Res.* (330):3–12, DOI 10.1097/00003086-199609000-00002. The original article and numerical rhythm claim were not inspected; reprint metadata is not verification of the stated split.
- Troke 2005, Youdas 1992, Winter, Perry/Burnfield, lunge, balance and march: exact works/editions, tables/pages, task conditions and applicable channels remain to be verified. The historical tables below do not fill those gaps.
- Raw subject trajectories, source-to-rig coordinate reconciliation, complete body/side/phase coverage, native applicability and clinical sign-off remain unverified. No source license or redistribution permission was inferred from public access.

The master defects remain open. This bounded correction supplies bibliography and factual aggregate/phase evidence; it is not full closure of either reference defect.

---

## Historical authored movement sheet

All angles, coordination statements and timings below are preserved authoring choices from the original sheet, awaiting current source and task review. The historical shoulder-readout caveat (~140° saturation), lack-of-chair caveat, and claim that forward lean was preserved also lack a current scoped witness here. Use actual code and the master for current behavior.

## Lower-quarter — functional

### Squat  ·  `squat`  ·  planted, bilateral
**Historical coordination assumption:** hip/knee flex together (~1:1.2), ankle dorsiflexion and ~25° trunk lean. The former 20° cap and “true deep squat demands ~30°” claim are historical and do not establish current runtime behavior or a universal task requirement. See the source scope above.
**Timing:** descent 1000 ms → hold 350 ms → ascent 1000 ms.

| Phase | Hip flex | Knee flex | Ankle DF | Lumbar flex | Thoracic flex |
|---|---|---|---|---|---|
| bottom | 100° | 120° | 20°* | 27° | 10° |
| stand | 0° | 0° | 0° | 0° | 0° |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

### Sit-to-stand  ·  `sit-to-stand`  ·  planted, bilateral
**Historical coordination assumption:** forward trunk/hip lean (“nose over toes”), followed by hip/knee extension. The old preserved-lordosis/compensation rule and regional angle allocation are unsupported by the accessed Schenkman material. Use the four-phase framework above without inferring those numerical or diagnostic rules.
**Timing:** seated 700 ms (hold 300) → lean 500 ms → rise 800 ms.

| Phase | Hip flex | Knee flex | Ankle DF | Lumbar flex | Thoracic flex |
|---|---|---|---|---|---|
| seated | 85° | 95° | 12° | — | — |
| lean-forward | 105° | 95° | 18° | 12° | 10° |
| stand | 0° | 0° | 0° | 0° | 0° |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

### Forward lunge / split squat  ·  `forward-lunge`  ·  planted, R lead
**Coordination:** lead hip+knee flex (~75°/90°); trail knee flexes ~90° with its hip near-neutral / slightly extended; trunk near-vertical.
**Timing:** descend 900 ms (hold 300) → rise 900 ms.

| Phase | Lead hip | Lead knee | Trail hip | Trail knee | Lumbar flex |
|---|---|---|---|---|---|
| descend | 75° | 90° | −10° (ext) | 90° | 8° |
| rise | 0° | 0° | 0° | 0° | 0° |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

### Single-leg stance (balance)  ·  `single-leg-stance`  ·  planted (stance leg)
**Coordination:** stance on L, lift R — lifted hip ~30°, knee ~45°; trunk quiet and level over the stance foot. Long hold = balance challenge.
**Timing:** lift 700 ms → hold 1500 ms → lower 700 ms.

| Phase | Lifted hip | Lifted knee |
|---|---|---|
| lift-and-balance | 30° | 45° |
| lower | 0° | 0° |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

### High-knee march (reciprocal)  ·  `high-knee-march`  ·  floating, in place
**Coordination:** one hip+knee flex to lift the leg while the **contralateral** arm swings forward (~38° shoulder flexion, an exaggerated march amplitude vs ~25° normal gait); sides alternate — the cross-body coordination of gait, without travel.
**Timing:** knee-up 550 ms (hold 120) → down 450 ms, alternating.

| Phase | Step hip | Step knee | Contralateral arm |
|---|---|---|---|
| right-knee-up | 60° | 80° | 38° (L shoulder flex) |
| left-knee-up | 60° | 80° | 38° (R shoulder flex) |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

---

### Walk — gait cycle  ·  `walk`  ·  planted, in place, loops
**Coordination:** one full gait cycle authored as 8 phases (both steps), looping
continuously. Sagittal peaks per normal free gait (Perry & Burnfield; Neumann):
hip 30° flexion at initial contact → −10° extension at terminal stance; knee ~5°
at contact → ~18° loading-response shock absorption → ~40° pre-swing → ~60° peak
in initial swing; ankle rockers — plantarflexion to foot-flat (−8°) after contact,
dorsiflexion to 10° as the tibia advances, push-off plantarflexion −15° at
pre-swing. Reciprocal arm swing ±20° shoulder flexion, each arm peaking with the
**contralateral** leg. Presented **in place** (treadmill convention — the looping
stage cannot accumulate root travel), so the stance foot sweeps backward under
the body while the swing foot advances, exactly as on a treadmill.
**Timing:** 8 × 200 ms phases → 1.6 s cycle (~75 steps/min, a deliberate
observation cadence; the speed modifier scales it 0.4–1.5×).

| Phase (per side) | Hip | Knee | Ankle | Contralateral arm |
|---|---|---|---|---|
| initial contact | 30° | 5° | 0° | 20° shoulder flex |
| loading response | 25° | 18° | −8° | 12° |
| mid-stance | 5° | 8° | 5° | 0° |
| terminal stance | −10° | 5° | 10° | −20° |
| (swing values are the opposite side's stance phases: pre-swing knee 40°/ankle −15°, initial-swing knee 60°, mid-swing hip 20°/knee 45°, terminal-swing hip 30°/knee 5°) |||||

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

---

## Upper-quarter

### Shoulder flexion — forward elevation  ·  `shoulder-flexion-elevation`  ·  R
**Historical coordination assumption:** humerothoracic forward elevation to 120°. The former full-range and fixed 2:1 split statements are unsupported as universal rules; task-specific Namdari results and variable McQuade rhythm are described above.
**Timing:** elevate 1200 ms (hold 300) → lower 1200 ms.

| Phase | Shoulder flexion (humerothoracic) |
|---|---|
| elevate | 120° |
| lower | 0° |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

### Shoulder abduction — lateral elevation  ·  `shoulder-abduction-elevation`  ·  R
**Historical coordination assumption:** humerothoracic lateral elevation to 120°. The same full-range/fixed-rhythm limitations apply; this target is not validated for every elevation or overhead task.
**Timing:** abduct 1200 ms (hold 300) → lower 1200 ms.

| Phase | Shoulder abduction (humerothoracic) |
|---|---|
| abduct | 120° |
| lower | 0° |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

---

## Spine / cervical — AROM screens

### Cervical rotation  ·  `cervical-rotation`  ·  floating
**Coordination:** pure axial rotation; flexion and side-bend near zero. ~70° each way (normative ~80°).
**Timing:** rotate 700 ms (hold 300) → centre 500 ms, each side.

| Phase | Neck rotation |
|---|---|
| rotate-left | +70° (toward L) |
| rotate-right | −70° (toward R) |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

### Lumbar flexion / extension  ·  `lumbar-flexion-extension`  ·  planted
**Coordination:** spine-dominant trunk AROM (distinct from the hip-dominant hinge) — round forward through lumbar then thoracic, return, then extend backward; little hip motion.
**Timing:** flex 1000 ms (hold 300) → return 800 ms → extend 1000 ms (hold 300) → return 800 ms.

| Phase | Lumbar | Thoracic |
|---|---|---|
| flex-forward | 55° | 25° |
| extend-back | −20° (ext) | −10° (ext) |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

---

## Historical sign-off form — remains unsigned

| Reviewer | Role | Date | Overall |
|---|---|---|---|
| ____________________ | PT / SME | __________ | ☐ approved as-authored ☐ approved with the edits above |

The original instruction was to drop the `verify with SME` flags after a sheet sign-off. That instruction is retained as historical provenance, not the current acceptance process. This citation audit removes no flags and records no clinical sign-off. Any future approval needs its exact task/context, reviewer and supporting evidence in the master.
