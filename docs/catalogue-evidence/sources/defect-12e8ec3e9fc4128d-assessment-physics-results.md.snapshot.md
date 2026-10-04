# Shared physics integration across the 20 core movements

Contact qualification verified 2026-10-02: contact version v8, controller v16. Engine change: [pose-engine #168](https://github.com/danstonedev/pose-engine/pull/168). Release and deployment records are tracked in the accompanying host pull request.

All **64 contexts** initialized and ran. **44/64** reached the captured route end; **20/64** stopped at a measured physical gate; **zero installation/invariant errors**. All **32 previous sampled tracking passes** remain passing. The foundation shipment had 36 completions and 28 stops. No movement gains clinical acceptance from these counts.

All six newly stopped foundation cases now complete, alongside female extension clearing and female push-up. Only the two extension-clearing source routes changed; the other 62 source route hashes are identical. Shared prone support uses measured pelvis skin and coordinated shoulder abduction/rotation. Passive skin contact activates at 0.9 mm; travel stops activate up to 1 mm early with a 2 ms requested time constant (native timestep safety retained). Material properties, travel bounds, motor capacities and failure thresholds are unchanged.

[Per-case comparison and hashes](evidence/posed-contact-2026-10-02.json). Local editor: http://127.0.0.1:5199/edit. Existing saved captures are preserved; create a new extension-clearing movement to use the revised source.

| Movement | Native execution | Requested duration reached | Remaining numerical result |
| --- | --- | --- | --- |
| aslr | 4/4 | 4/4 | No numerical stop; movement acceptance pending |
| deep squat | 2/2 | 2/2 | No numerical stop; movement acceptance pending |
| hurdle step | 4/4 | 0/4 | native-joint-speed, native-contact-residual, native-self-contact-residual |
| in line lunge | 4/4 | 0/4 | native-contact-residual |
| flexion clearing | 4/4 | 4/4 | No numerical stop; movement acceptance pending |
| rotary stability | 4/4 | 0/4 | native-self-contact-residual, native-contact-residual |
| shoulder clearing | 4/4 | 4/4 | No numerical stop; movement acceptance pending |
| shoulder mobility | 4/4 | 4/4 | No numerical stop; movement acceptance pending |
| extension clearing | 2/2 | 2/2 | No numerical stop; movement acceptance pending |
| trunk stability push up | 2/2 | 2/2 | No numerical stop; movement acceptance pending |
| cervical extension | 2/2 | 2/2 | No numerical stop; movement acceptance pending |
| cervical flexion | 2/2 | 2/2 | No numerical stop; movement acceptance pending |
| cervical rotation | 4/4 | 4/4 | No numerical stop; movement acceptance pending |
| multisegmental extension | 2/2 | 2/2 | No numerical stop; movement acceptance pending |
| multisegmental flexion | 2/2 | 0/2 | native-contact-residual |
| multisegmental rotation | 4/4 | 0/4 | native-contact-residual, native-joint-speed, native-self-contact-residual |
| overhead deep squat | 2/2 | 0/2 | native-self-contact-residual |
| single leg stance | 4/4 | 4/4 | No numerical stop; movement acceptance pending |
| upper extremity pattern one | 4/4 | 4/4 | No numerical stop; movement acceptance pending |
| upper extremity pattern two | 4/4 | 4/4 | No numerical stop; movement acceptance pending |

## What changed

- A shared passive surface lattice now transfers floor and self-contact forces into the articulated body. Its recorded displacement also deforms the displayed skin. It is a coarse spring/damper contact model, not a calibrated volumetric tissue simulation.
- Measured convex thigh, shank, foot and toe profiles replace broad lower-limb envelopes. Each foot has three passive plantar regions. Nearby regions on the same skeleton chain retain documented exclusions; opposite limbs remain collidable.
- Standing initialization and heel readouts use the actual outer foot surfaces. Both pelvis and independently grasped bar receive the same one-time setup shift. No later root position is imposed by the solver.
- Shared support control anticipates single-leg load transfer, uses actual loaded contact authority, damps approaching joint stops and prioritizes balance. Shared reference hip abduction capacity is 85 Nm; reduced capacity remains 55% with unchanged ranges. The capacity assumption and its source are recorded in [assessment-capacity.mjs](../experiments/lower-body/assessment-capacity.mjs).
- Newly generated quadruped routes use the fitted hand/knee source setup. Whole-chain retargeting records source-to-native position/orientation errors. Existing captures remain editable and unchanged.
- Explicit Prone rest intervals yield under gravity, and supine secondary posture retains resting alignment. Separate three-second floor probes verify distributed support on both source models. Single-leg guides preserve bearing foot orientation during transfer; actual sustained support and return are checked independently of timing.

## Verification and limits

The matrix checks finite native and surface states, bounded motor effort, zero externally applied root wrench, preserved captures/timestamps, correct contact identity and terminal stopping behavior. Native tissue tests check loaded compression, recoil, mass conservation, self-collision momentum and 1/2 ms behavior. Display tests verify displacement under blended skin transforms, repeatability and restoration of original geometry.

FMS ASLR and bar-equipped squat retain their specialized joint controllers; the remaining 18 entries use the shared assessment controller. All consume the same contact setting and state protocol. Physics settings invalidate stale trial identities; saved poses are not deleted.

Moving transitions, dynamic recovery, source target accuracy and apparatus contact still require qualification in the incomplete cases above. Resting support qualification is documented separately from these moving routes. The 81 SFMA breakouts are outside this 20-entry scope. Numerical completion alone never marks a movement accepted.

- [Exact native matrix](../../remaining-batches/posed-contact-qualified-matrix.json)
- [Current support checks and reproduction](archive/support-acceptance.md)
- [Measured contact refinement](archive/measured-contact-refinement.md)
- [Shared contact design and focused tests](archive/shared-deformable-contact.md)
- [Reproducible export, native and browser commands](core-physics-verification.md)
- [Earlier rigid v10 matrix](../.validation.local/assessment-physics-v10-ui.json)

## Historical foundation comparison

The earlier v7 foundation matrix retained all 32 sampled tracking passes but introduced six clock-completion stops: flexion clearing on both models/sides, male extension clearing and male push-up. Female multisegmental extension started reaching its end. Those seven source route hashes were unchanged, and none met the tracking diagnostic before or after. The v8 qualification above resolves all six stops and adds two further completions; it still retains the same 32 tracking passes. Stop thresholds, joint bounds and motor capacities remain unchanged. See [the Blender foundation scope and remaining work](blender-body-physics.md).

[Committed per-case foundation evidence and source hashes](evidence/body-foundation-2026-10-02.json).
