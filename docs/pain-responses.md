# Movement-evoked pain responses

PR candidate, 2 October 2026. This is an authored expression layer;
channel weights, intensity bands and timings are animation choices. They are
not validated conversions between facial activity and a patient's pain score.

## Research basis

Prkachin's experimental study identifies brow lowering, eyelid tightening or
closure and nose/upper-lip actions across several painful stimuli:
[Pain, 1992](https://pubmed.ncbi.nlm.nih.gov/1491857/).
The shoulder-pain study examines expression during painful movement and
individual expressiveness:
[Prkachin and Solomon, 2008](https://pubmed.ncbi.nlm.nih.gov/18502049/).
The rheumatoid-arthritis observation study distinguishes guarding, bracing,
rubbing, rigidity, grimacing and sighing, with different behavioral subgroups:
[Keefe et al., 2008](https://pmc.ncbi.nlm.nih.gov/articles/PMC2525808/).
Kunz and Lautenbacher report different facial patterns, including participants
who show no facial reaction during pain induction:
[European Journal of Pain, 2014](https://pubmed.ncbi.nlm.nih.gov/24174396/).

These sources support the selection of behaviors and variation between people.
They do not supply this implementation's numerical weights, hand-curl targets,
latencies, reflex physiology, individual patient behavior or whole-body trajectories.
Hand squeezing is an illustrative animation choice; it is not a universal pain sign.

## Progression

The engine interpolates continuously. These bands describe the default sustained
grimace at ordinary expression settings; they are not clinical categories.

| Selected intensity | Visible response |
| --- | --- |
| 0 | No added expression or squeeze |
| 1–3 | Subtle brow/lid tension; little hand activity |
| 4–6 | Stronger brow and mouth tension, initial hand tightening, bounded recoil |
| 7–8 | More pronounced squint, partial eye closure, lip/nose tension and squeeze |
| 9–10 | Strongest selected combination, still bounded by expression and hand limits |

Visible expression is a separate 0–100% control. It can be zero at any intensity.
The timeline provides onset, a single recoil opportunity, a sustained response,
and recovery. Pause, seek and loop use playback time rather than a random clock.
Pain paint and the finding keep their existing meanings; an animation setting
does not rewrite the patient's reported symptoms or the measured joint angle.

## Ownership and support

`painResponseAt` owns channel selection and timing. `createPainResponseLayer`
owns temporary facial skin deformation and optional digit rotations. Source
position deltas are extracted from the retained male/female production source
assets only after position, normal, UV, joint and skin-weight bytes match the
runtime bodies. Per-stage geometry is cloned; normals are recomputed on the
deformed triangles. After drawing, original skin and bone values are restored.
The runtime GLBs, topology, UV atlas and source skin weights are unchanged.

The layer tightens a three-phalange chain using the existing clinical curl
readout and intersected patient/registry limits. It preserves the posed baseline,
caps fingers at 130° and thumbs at 70°, and changes only explicitly free hands.
simLAB currently enables this only for resting hands in supine hip/knee tests.
Its existing neck/thorax recoil is scaled within the original 10°/6° bounds.
All other joints, helper derivation, root, assessed limb, support and examiner
grips retain their original controllers. Every current rig bone is accounted
for in the master work unit; absence of a reaction target does not imply a hold.

The neutral body has no matching facial source; only its hand reaction is
enabled. Body shifts, unloading, rubbing, altered breathing and movement
interruption require explicit support/motion authoring and remain disabled.
The pure response exposes guarding/shift channels for future bounded authoring;
their presence does not mean a host currently animates them.

## Local integration and evidence

- simLAB: Movement lab, select a painful test, then adjust **Pain intensity
  (animation)** and **Visible expression**. Both familiar and explicitly painful
  other sensations can be animated; isolated numbness/tingling does not acquire
  a pain reaction. Case steps can explicitly author `felt.response`; case
  narratives without it retain their existing behavior.
- simMOVE: `/pain-lab` previews the same shared implementation, with playback,
  body selection and an optional face camera.
- Editable full-cycle Blender project and current exchange evidence:
  workspace `blender-workspace/pain-response-review-2/`. It contains hip PROM on
  male/female/neutral, both sides, at intensities 2 and 8 (12 scenes).
- Local test/typecheck/browser evidence: workspace `remaining-batches/pain-*`.
  The first replay attempt is retained: the previous verifier omitted morph
  positions; the corrected verifier uses the rendered skinned vertex position.

Facial and hand expression is excluded from clean stage captures and native
force calculations. The scaled authored recoil remains part of the lab's sampled
movement. No MuJoCo model, actuator, contact parameter or force/deformation
result has been changed or relabeled. Native dynamics and clinical acceptance
of these pain behaviors are not established. The master retains the open
neutral-face and support-shift limitations. These changes are local, not deployed.

## Student perspective review, 2 October 2026

The first walkthrough found that starting at 1.6 seconds skipped the initial
response, a whole-body view made subtle facial changes difficult to inspect,
and the short label "Mild" could be confused with the independent animation
intensity. The interface also needed an explicit comparison showing that the
same selected intensity can have different amounts of visible expression.

The preview now starts before onset, offers replay from the start and jumps to
onset, sustained response and recovery, and pauses when scrubbed. Its face and
whole-body views support observation of different regions. Two 8/10 examples
vary expression only. An observation guide and a short learning check explain
that this is one possible response, not a pain scoring instrument. The neutral
model starts in the whole-body view and does not offer a facial-expression view.

simLAB offers a paused face close-up and expression comparisons that preserve
the selected intensity and written finding. "Describe the symptom as mild"
clearly labels the narrative setting, and the animation settings have their own
explanation. The close-up approaches a supine face from the feet to keep it
upright with the existing world-up camera; reset restores the test view.

This review changes camera, playback controls and teaching presentation. It
does not tune expression weights, bone trajectories, clinical limits, native
inputs or source skin assets. The earlier Blender project remains the retained
motion-exchange evidence, not a new clinical approval. At that checkpoint,
individual patterns, support-specific shifting and neutral facial animation
remained open; the pattern implementation is documented below.

Reproducible browser checks, before/after captures and current check logs are
in workspace `remaining-batches/pain-student-review/` and
`remaining-batches/pain-student-*.log`. The real-rig camera check covers male and
female in supine and sitting positions, upright framing, every bone's unchanged
local rotation and restoration of the test camera. The student walkthrough is
an engineering usability review; no student participant study was conducted.

## Selectable response patterns

Both hosts now consume six patterns from the same pure engine definition:

| Pattern ID | Facial response | Movement response |
| --- | --- | --- |
| `grimace` | Sustained brow lowering, narrowed eyes and mouth tension | Sustained free-hand tightening; original bounded onset recoil |
| `wince` | A brief eyelid/brow response, then much less tension | One hand pulse at onset that softens; bounded onset recoil |
| `eye-squeeze` | More eye closure, less brow movement | Sustained squeeze; smaller recoil |
| `open-mouth` | Narrowed eyes with source lip-opening and jaw-shape deltas | Brief hand pulse; moderate recoil |
| `raised-brow` | Raised inner brows with some eyelid/mouth tension | Smaller sustained hand response and recoil |
| `quiet` | No added facial response | Small free-hand tightening; no added recoil |

The patterns illustrate variations described in the primary facial-expression
research above. Their channel mixtures, hand behavior, recoil scales and time
courses are authored examples, not measured population trajectories. A pattern
does not identify a diagnosis, pain mechanism or particular pain intensity.
Jaw/lip names refer to source skin shapes; they do not establish a clinical jaw
angle or a separately calibrated jaw controller. All original facial bones,
upper/lower teeth and tongue retain their existing owners.

In simLAB, select **Response pattern** and **Reacting free hands** in the
animation settings. Left/right/both/neither is intersected with the hands allowed
to react for that test; choosing a supporting hand does not release its support.
Settings preserve the assessed limb, finding, cue boundaries and timing. Only
the existing authored neck/thorax recoil is scaled, within the prior bounds.
simMOVE additionally offers a **Hands view** to inspect finger tightening.

For a case author, `felt.response.pattern` selects a pattern and
`felt.response.freeHands` explicitly declares which hands can react. Omitting
`pattern` keeps the original sustained grimace. Cases without `felt.response`
retain their existing behavior. Use `painRecoilScale` when authoring an existing
recoil; the render layer does not rewrite a case's sampled trajectory.

```ts
felt: {
  from: assessedFrame,
  familiar: { mild: false },
  others: [],
  response: { intensity: 8, expression: 0.65, pattern: 'wince', freeHands: ['L'] }
}
```

Current editable Blender review: workspace
`blender-workspace/pain-pattern-review-2/full-motion-review.blend`, with six
patterns on all three production bodies and both hip sides (36 full-cycle
clips). `pain-renders-2/pain-visual-review.blend` retains framed phase views.
The first candidate is retained in `pain-pattern-review-1`; its open-mouth
shape was too subtle, so the current candidate additionally uses the verified
source `V_Lip_Open` deltas. Runtime topology, atlas and source skin weights stay
unchanged. Browser captures and checks are in
`remaining-batches/pain-variety-browser-2/`; numerical results and source hashes
are retained alongside the project and in the `pain-variety-*` logs. The scoped
verification record is workspace `remaining-batches/pain-variety-evidence.json`.

Native validation remains unsupported for these DDx hip PROM response clips.
The facial/digit render layer does not enter clean recordings or native force
calculations; pattern-scaled authored recoil does change the lab's sampled
trajectory. No previous force result is attached to that changed trajectory.
Support-specific shifts, rubbing, unloading and neutral facial retargeting
remain disabled. Full-cycle authored visual/exchange checks do not establish
clinical acceptance or native dynamics.

## Scoped release candidate

The release candidate was rebuilt from the current main branches of pose-engine,
simMOVE and simLAB, with only the pain-response implementation and its review
tools. The retained record is
`docs/catalogue-evidence/pain-response-patterns/verification.json`. It records
the source hashes, base revisions, test results, browser checks and limitations.
Its sibling `editable-blender-review.zip` contains both editable Blender projects;
extract the archive to open `full-motion-review.blend` or
`pain-visual-review.blend`. The import and replay reports, render index, ten
comparison sheets and browser captures are retained alongside it. Historical
workspace reviews above describe earlier checkpoints, not this release candidate.

The fresh review covers 36 full-cycle hip PROM clips: six patterns, three actual
production bodies and both sides. It includes setup, onset, peak, hold, recovery
and return. Numerical replay uses the existing 0.1 mm tolerance and includes
morph-deformed skin before skinning. Browser and real-rig contact checks cover
the host presentation separately; the Blender exchange does not contain the
examiner or plinth.

simMOVE's pain preview imports the exact runtime GLBs directly. Its normal
public-model optimization quantizes positions, which would prevent the verified
facial deltas from matching. The normal editor model pipeline remains intact.
simLAB already imports these production models directly.

The required engine and simLAB catalogue checks fail on 1,356 changed contexts
that lack current reference/clinical acceptance. The same refreshed master is
retained in the shared engine for both host pins; historical tracking and reviews
are preserved. No acceptance was added, threshold changed or gate bypassed.
The PRs remain drafts until the required catalogue review and CI pass.
