# Shoulder movement consistency

The production shoulder uses pose-engine's existing clavicle/girdle proxy and upper arm. Its shared composer owns elevation distribution, explicit girdle overrides, arm axial rotation and ROM. Interactive posing and supported hand solving reuse that engine's rhythm and constraints. simMOVE does not maintain a second shoulder solver.

`/shoulder-lab` now opens **Shoulder review**, which uses `ExamStage3D` and `composeScreenMotion` with the same four upper assessment recipes as Screen and simLAB. Hold mode uses the shared assessed-position adapter. Captures and replay use the stage's recording API. No SC/AC/GH demo angles or independent-rig assets are used on this route.

The earlier independent rig remains available in the engine's development playground for asset research. Its hand-authored coordinated-elevation preset is not a production movement policy. It is not required to improve consistency of the existing rig.

The standard model assets, movement recipes, optional capacity policies and native physics controller are unchanged by this integration correction. Kinematic consistency does not imply that native physics tracks every movement successfully; the existing physics diagnostic gaps remain open.
