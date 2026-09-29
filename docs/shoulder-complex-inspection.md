# Shoulder direction inspection

`inspectShoulderComplex` measures a pose in its live thorax and girdle frames.
It accepts current/rest shoulder-to-elbow world directions and arm, thorax and
girdle world quaternions. Capture the corresponding reference before motion;
use the calibrated humeral long axis, not an assumed local bone axis. When the
reference is globally rotated, also supply its anterior world direction.

The inspector returns:

- Rest-relative directional elevation in the thorax and existing girdle proxy.
- Plane of elevation (anterior zero, outward positive for either side), with
  explicit invalidity when the plane cannot be determined.
- Signed right-handed twist about the rest long axis after shortest-swing
  removal. This convention has no clinical left/right sign flip; antiparallel
  axes have no unique swing and return a null twist.
- Margin/excess against a configurable engineering proxy-elevation budget
  (120 degrees by default), separate from measurement availability.
- Nullable measurements and diagnostics for missing or invalid references.

The function is pure and does not alter recipes, manual commands, IK, rendering,
legacy angle readouts or planning outcomes. Callers can inspect measurements
without enabling a new movement policy. A `complete` result means both
directional elevations are available; it is not motion acceptance or proof
that the budget was satisfied. Check individual validity flags and capacity.

These quantities are not independent GH, SC, AC or ST measurements. The current
asset has one combined girdle proxy. The budget is a model constraint, not a
patient-specific or universal anatomical limit. Directional elevation differs
from legacy sagittal/frontal projection angles; subtracting unlike definitions
does not establish a commanded-motion shortfall.

Validation covers analytic poses, both sides, missing/malformed data, rotated
reference frames, twist and plane singularities, plus 390 production-rig poses:
three models, two sides, thirteen commands and five root/thorax orientations.
The fixture preserves prior independently measured directional values. Parent
invariance uses a 0.00001-degree numerical tolerance for elevation/twist; plane
tolerance accounts for its ill-conditioning near the resting long axis. No
existing ROM, contact or clinical acceptance threshold changes.

Integrating these measurements into runtime feedback and enforcing compatible
combined shoulder commands remain separate work. This API does not complete
the shoulder-coordination audit batch.
