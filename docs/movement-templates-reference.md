# Movement Template Reference — SME Verification Sheet

**Purpose.** The composed-motion planner (simMOVE / simLAB) now anchors on a small
library of clinician-authored reference templates for core clinical movements
(`pose-engine/src/services/movementTemplates.ts`). Each template encodes the three
things that make a movement recognizable — **peak joint angles**, **phase timing**,
and **coordination** — so the language model starts from an authored clinical
pattern instead of guessing joint angles from scratch.

**What is already guaranteed by automated tests** (`__tests__/movementTemplates.test.ts`,
run against the real male rig):

1. **ROM-validated** — every authored peak passes through the ROM clamp
   *unchanged*, i.e. nothing exceeds the normative range in the ROM registry
   (AAOS / Norkin & White).
2. **Rig round-trip** — playing each template on the actual GLB measures the
   authored peaks back within **±6°** on the primary joints.

**What this sheet is for.** The *values themselves* — the specific peak angles,
tempos, and joint contributions — are authored from standard kinesiology and are
flagged `verify with SME` in code. This sheet lays them out for a physical
therapist to confirm or correct. Tick **Status** and add **Notes**; anything you
change, I update in the template file and the tests re-verify it.

**Reference sources used for the authored values:**

- Norkin CC, White DJ. *Measurement of Joint Motion: A Guide to Goniometry.*
- AAOS. *Joint Motion: Method of Measuring and Recording.*
- Neumann DA. *Kinesiology of the Musculoskeletal System.* (coordination, scapulohumeral rhythm ~2:1)
- Bohannon RW. Sit-to-stand and functional-task norms.

**Known measurement caveats (rig, not clinical):**

- **Shoulder elevation** is measured *humerothoracic* (as a goniometer reads it),
  and the world-frame readout saturates past ~140°. So shoulder templates target a
  **functional 120°** and teach scapulohumeral rhythm as coordination *guidance*
  rather than commanding the scapula separately (which would double-count in the
  readout). Full physiologic elevation (~160–170°) is noted in the text.
- **Sit-to-stand** has no chair prop; the seated depth is represented as the
  hip/knee flexion hold. The clinically important feature — the forward lean before
  rising — is preserved.

---

## Lower-quarter — functional

### Squat  ·  `squat`  ·  planted, bilateral
**Coordination:** hip and knee flex together (~1:1.1), ankle dorsiflexes, trunk leans forward ~20° to keep COM over the mid-foot.
**Timing:** descent 1000 ms → hold 350 ms → ascent 1000 ms.

| Phase | Hip flex | Knee flex | Ankle DF | Lumbar flex | Thoracic flex |
|---|---|---|---|---|---|
| bottom | 100° | 115° | 18° | 20° | 10° |
| stand | 0° | 0° | 0° | 0° | 0° |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

### Sit-to-stand  ·  `sit-to-stand`  ·  planted, bilateral
**Coordination:** forward trunk/hip lean ("nose over toes") brings COM over the feet *before* hip/knee extension — flexion momentum first, then extension.
**Timing:** seated 700 ms (hold 300) → lean 500 ms → rise 800 ms.

| Phase | Hip flex | Knee flex | Ankle DF | Lumbar flex | Thoracic flex |
|---|---|---|---|---|---|
| seated | 85° | 90° | 12° | — | — |
| lean-forward | 100° | 90° | 18° | 25° | 10° |
| stand | 0° | 0° | 0° | 0° | 0° |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

### Forward lunge / split squat  ·  `forward-lunge`  ·  planted, R lead
**Coordination:** lead hip+knee flex (~55°/90°); trail knee flexes ~90° with its hip near-neutral / slightly extended; trunk near-vertical.
**Timing:** descend 900 ms (hold 300) → rise 900 ms.

| Phase | Lead hip | Lead knee | Trail hip | Trail knee | Lumbar flex |
|---|---|---|---|---|---|
| descend | 55° | 90° | −10° (ext) | 90° | 8° |
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
**Coordination:** one hip+knee flex to lift the leg while the **contralateral** arm swings forward (~25° shoulder flexion); sides alternate — the cross-body coordination of gait, without travel.
**Timing:** knee-up 550 ms (hold 120) → down 450 ms, alternating.

| Phase | Step hip | Step knee | Contralateral arm |
|---|---|---|---|
| right-knee-up | 60° | 70° | 25° (L shoulder flex) |
| left-knee-up | 60° | 70° | 25° (R shoulder flex) |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

---

## Upper-quarter

### Shoulder flexion — forward elevation  ·  `shoulder-flexion-elevation`  ·  R
**Coordination:** humerothoracic forward elevation to ~120° functional (full physiologic ~160–170°); scapulohumeral rhythm ~2:1 (≈2/3 glenohumeral, 1/3 scapular upward rotation) — taught as guidance, scapula not commanded separately.
**Timing:** elevate 1200 ms (hold 300) → lower 1200 ms.

| Phase | Shoulder flexion (humerothoracic) |
|---|---|
| elevate | 120° |
| lower | 0° |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

### Shoulder abduction — lateral elevation  ·  `shoulder-abduction-elevation`  ·  R
**Coordination:** humerothoracic lateral elevation to ~120° functional (full physiologic ~160–170°); same 2:1 scapulohumeral rhythm as guidance.
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
| extend-back | −20° (ext) | −15° (ext) |

**Status:** ☐ approved ☐ adjust → _______   **Notes:** ______________________

---

## Sign-off

| Reviewer | Role | Date | Overall |
|---|---|---|---|
| ____________________ | PT / SME | __________ | ☐ approved as-authored ☐ approved with the edits above |

*After sign-off, drop the `verify with SME` flags in `movementTemplates.ts` (the
`VERIFY` constant) and record the reviewer + date in this sheet.*
