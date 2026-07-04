# @vspx/pose-engine

Shared 3D **pose engine** (the gold standard) for the body-chart and
aquatic-therapy apps. Pure THREE.js pose math + rig configuration — no Svelte,
no pain-map / EMR dependencies.

## What's inside

| Module | Purpose |
|--------|---------|
| `anatomy/bodyVariants` | Rig config, canonical bone map, anatomic pose targets, body variants |
| `services/poseRig` | FK swing + CCD-IK solve, pose serialize/apply/blend |
| `services/jointAngles` | Clinical joint-angle measurement from the live skeleton |
| `services/romRegistry` | Range-of-motion definitions per joint/plane |
| `services/poseRomClamp` | ROM clamping (calibration-gated via `__enableRomClamp`) |
| `services/cameraTween` | View presets + orbit-tween math |
| `services/limbAxisModel` | Proximal→distal limb polylines |
| `services/movementClipSampling` | Sample GLB animation clips into bone poses |

## Usage

Consumed as a **git submodule**; apps alias `@vspx/pose-engine` → `pose-engine/src/index.ts`.

```ts
import { getBodyVariant, buildBoneByPoseKey, solveIKChain, computeJointAngles } from '@vspx/pose-engine';
```

`three` is a peer dependency (the host app provides it).

## simMOVE

`playground/` is the first-party front end for this package and is branded
as **simMOVE**. It is intentionally kept inside `pose-engine` so the visual
cannot drift into a separate rig, math layer, or copied mannequin surface.

Rules for simMOVE:

- Import pose, ROM, rig, viewer, and clinical angle behavior from `../src`.
- Keep app-specific catalogs, EMR data, and scenario orchestration outside this
  package.
- Copy runtime GLBs only into `playground/public/models/` at dev/build time.
- Treat failures in `npm run check`, `npm test`, or `npm run build:simmove` as
  engine regressions, not downstream app problems.

Run it locally:

```bash
npm run simmove
```

## Develop

```
npm install
npm run simmove # local simMOVE visual
npm run build:simmove
npm run check   # tsc --noEmit
npm test        # vitest (86 pose tests)
```

> Note: `getMovementClipSpeed` / the `MOVEMENT_CLIPS` catalog are intentionally
> NOT here — the clip catalog is an application concern. Apps own their catalog
> and pass speed scalars in.
