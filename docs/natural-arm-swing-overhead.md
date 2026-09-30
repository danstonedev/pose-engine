# Natural arm swing and overhead movement corrections

Walking, impaired gait, running, marching and turns now share `locomotorArmSwing.ts`. It coordinates bilateral clavicle/girdle motion, humeral rotation, elbow lag, forearm rotation, wrist drag/deviation and all five finger chains. Zero swing scales the entire chain rather than leaving the elbow and wrist pumping. Explicit zero targets prevent a preceding frame's rotation from persisting accidentally. Running reversals follow the actual flight/touchdown clock.

`locomotorArmClearance.ts` checks the posed forearm and hand against both thighs and shanks after foot-contact solving. It opens the arm only as much as the capsule envelope requires, within available shoulder ROM. Playback and offline recording call the same function. This replaces simLAB's fixed outward arm offset. Reaches and hand-supported tasks retain their own arm recipes.

Jump now raises and tilts the shared girdle proxy with the humerus, adds external rotation during elevation, and explicitly releases those channels on landing. The ballistic and lower-limb recipe is unchanged.

FMS deep squat and the legacy SFMA overhead squat share an overhead arm/stance recipe. Both establish their stance before descent, retain nearly straight elbows and coordinated girdles, and keep the setup foot orientations through contact solving. FMS keeps an authored bilateral dowel grip; SFMA uses open hands without a dowel. The legacy SFMA's old feet-together setup was incorrect: the published procedure uses shoulder-width feet and overhead arms just outside shoulder width ([original protocol appendix](https://pmc.ncbi.nlm.nih.gov/articles/PMC4004125/), [subsequent methods](https://pmc.ncbi.nlm.nih.gov/articles/PMC5675369/)). Its deeper descent also needs coordinated hip and trunk flexion to keep mass over the base. This does not change current arms-down SFMA protocols or scoring.

The complete FMS recipe commands all 61 available channels. The previous 58-target limit dropped the last three right-hand fingers. The input bound is now 64, with explicit tests for the complete registry, no dropped recipe targets, and oversized imported input.

## Verification

- 72 locomotor tests cover all three bodies, walking pace, running, turns, marching, reduced/unilateral swing, shoulder restrictions and six bilateral gait impairments. They check every-frame capsule clearance, independently skinned arm/leg intersection, and inter-frame arm rotation.
- 12 overhead rig tests cover setup width, foot drift, toe height, balance, shoulder capacity, independent arm/head skin clearance, complete bilateral grip, jump recovery and 30/120 Hz playback at two speeds.
- Live browser playback was compared with offline recording on all three bodies for walk, jump and both squats. Final-pose discrepancies were below 0.06 degrees and 1 mm. Full phase captures include front, side and rear views; the actual simLAB dowel layer was included in the FMS review.
- Existing tests describing the former single-axis overhead arm and feet-together stance now assert the new combined arm recipe and shoulder-width geometry. The ankle assertion measures the achieved post-contact foot orientation in its weight-bearing domain; it does not require an authored angle to survive positional IK unchanged.

## Limits

These are authored kinematics and geometric clearance, not passive arm torque simulation, contact forces, tissue compression, normative calibration or new clinical acceptance. The current production shoulder remains the shared clavicle/girdle proxy. Capsule clearance cannot guarantee all surface contacts for every body shape or severe ROM restriction; available patient ROM takes precedence. The dowel follows the hand grip landmarks and is not a force-bearing constraint. Existing restricted-depth squat and native-physics acceptance limitations remain open.

The qualitative coordination is consistent with [Collins et al., 2009](https://pubmed.ncbi.nlm.nih.gov/19640879/); the numeric gains are engineering fits checked on the supported rigs, not values inferred from that study.
