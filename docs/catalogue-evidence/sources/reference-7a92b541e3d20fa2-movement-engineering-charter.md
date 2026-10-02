# Movement engineering charter

Adopted from the user's supplied prompt on 2 October 2026. This is the standing
standard for future movement improvement work. The session deliverables below
apply to each bounded improvement; they do not authorize a new merge or deployment.

Read alongside [the Blender workflow](blender-workflow.md) and
[the current status and priorities](movement-improvement-status.md).
The original supplied prompt follows, with its requirements preserved.

---

Act as my lead technical partner for advancing the human movement simulation system in simLAB / DevPT. Approach this as a combined biomechanics, physics simulation, Blender rigging, software architecture, and clinical education project—not merely an animation improvement task.

MISSION

Transform our existing Blender + AI workflow into a repeatable system for authoring, simulating, validating, and delivering anatomically credible, physically realistic human movement.

The eventual scope spans quiet standing, isolated joint movement, reaching, gait, transfers, functional assessments, exercise, loaded movement, jumping, landing, inversions, and complex gymnastics.

The bodies must do more than look convincing. Their joint coordination, support, contact, deformation, and physical behavior must be appropriate for the intended educational use. Clearly distinguish visually authored behavior, physics-based simulation, and behavior validated against experimental evidence.

Use the existing system as the foundation. Do not replace working infrastructure or introduce competing physics systems without a demonstrated need.

PROJECT CONTEXT TO VERIFY

Relevant repositories include:
- danstonedev/simlab
- danstonedev/pose-engine
- danstonedev/simmove

Relevant starting documents include:
- pose-engine/docs/blender-workflow.md
- simmove/docs/blender-body-physics.md
- simmove/docs/assessment-physics-results.md

There may also be a local blender-workspace directory containing movement-authoring and whole-body physics projects.

Previous documentation describes Blender authoring, GLB/Three.js round-trip verification, a MuJoCo-based native simulation pathway, regional compliant contact, and differences between native simulation and simLAB playback.

Treat those descriptions as leads to investigate—not proof of the current implementation. Inspect actual source, assets, configuration, tests, and available runtime behavior. Verify the installed Blender version and use version-matched official documentation. Do not upgrade dependencies simply because newer versions exist.

FIRST: AUDIT THE ENTIRE PIPELINE

Trace the actual path from:

Blender authoring → exported assets and physical parameters → native simulation → pose-engine → simLAB presentation and interaction.

Determine:
- Which representations and parameters are authoritative.
- Which functionality is implemented, partially connected, missing, or documented but unverified.
- Where joint conventions, geometry, contact, tissue properties, deformation, timing, or computed forces diverge.
- Which supported body variants and movements have actual evidence.
- Which results are authored animation, recorded simulation replay, or live simulation.
- Whether students currently see the same behavior that was approved in the native simulation.
- What tools and local execution access are actually available.

Report the most consequential findings briefly, then implement the highest-value bounded improvement. Do not stop after producing a roadmap.

TARGET ARCHITECTURE

Unless the audit demonstrates a compelling reason to change it:

- Blender is the editable anatomy, rigging, collision-authoring, deformation, motion-authoring, and visual inspection environment.
- ChatGPT or Claude develops tools, proposes edits, executes permitted workflows, and analyzes evidence.
- The existing MuJoCo integration calculates articulated dynamics, actuation, support, and the contact/compliance represented by its model.
- Automated validation determines whether a candidate meets explicit acceptance criteria.
- pose-engine and simLAB deliver approved motion, deformation, interaction, and synchronized measurements.
- Specialist musculoskeletal or volumetric tissue solvers are introduced only for specific requirements that the existing system cannot adequately address.

Do not use an LLM as the per-frame physics controller. Build reproducible controllers and tools that operate independently of conversational prompts.

CORE ENGINEERING REQUIREMENTS

1. SHARED ANATOMICAL JOINT DEFINITIONS

Establish or strengthen a shared specification for:
- Joint centers, coordinate systems, neutral references, and units.
- Degrees of freedom, permitted translations, movement limits, and modeled coupling.
- Left/right conventions and transformations between Blender, simulation, and browser coordinates.
- Segment dimensions, mass, center of mass, and inertia where used.
- The relationship between authoring controls, deformation bones, and physical segments.

Prioritize clinically meaningful coordination of the shoulder girdle, humerus, spine, pelvis, forearm, wrist, hand, ankle, foot, and toes.

Do not assume that a visually useful animation rig is already an anatomical model. Do not impose universal fixed coupling ratios without justification.

Add joint-axis overlays, isolated-movement tests, and cross-system comparisons. Use only the anatomical detail needed for the intended task, and explicitly identify unsupported joint-level claims.

2. CONTACT-AWARE MOTION

Treat contact as geometry, timing, load transmission, friction, compliance, and visible deformation—not simply intersection avoidance.

Evaluate:
- Body–floor and body–equipment contact.
- Self-contact and contact between opposite limbs.
- Palm support, hand-on-back contact, grasping where supported, and plantar loading.
- Contact coverage across changing poses.
- Gaps or discontinuities at articulated segment boundaries.
- Penetration, slipping, floating, tunneling, and unstable transitions.

Use collision representations appropriate for the solver. Do not assume the high-resolution render mesh should become the collision geometry everywhere.

Measure how well collision surfaces represent the visible skin throughout relevant movements. Add detail selectively where it materially improves behavior.

A movement must not pass because the skeleton clears an obstacle while the skin intersects it, or because an oversized invisible collider provides unrealistic support.

3. SOFT-TISSUE COMPRESSION AND DEFORMATION

Maintain a clear distinction between:
- Pose-dependent visual corrective deformation.
- Contact-driven regional compliance.
- Volumetric tissue mechanics.

Prioritize improving and calibrating the existing regional compliance system before attempting full-body high-resolution volumetric simulation.

Support controlled experiments involving:
- Tissue thickness and bounded compression.
- Force–displacement response.
- Stiffness, damping, recovery, and time dependence where modeled.
- Regional differences.
- Contact-driven skin displacement.
- Behavior under different body orientations and loads.

Verify that changing collision-cell density or geometry does not unintentionally change overall regional mechanical response.

Do not label engineering assumptions as patient-specific tissue properties. Do not invent calibration data. Where data are unavailable, document assumptions and perform sensitivity analysis.

Investigate MuJoCo deformables, SOFA, or FEBio only when a defined requirement warrants them. Evaluate compatibility and performance before introducing another solver.

4. WHOLE-BODY COORDINATION AND DYNAMICS

Build reusable task/controller families rather than disconnected animation clips.

Progress through:
- Resting support, quiet standing, and weight shifts.
- Isolated and compound joint movements.
- Reaching, squatting, lunging, transfers, gait, and stairs.
- Loaded tasks, push-ups, and quadruped transitions.
- Jumping, landing, dynamic recovery, inversions, and gymnastics.

Represent movement phases, support transitions, contact events, and actuator limits explicitly.

For demanding movements, assess whether success depends on physically plausible coordination rather than hidden root motion, unexplained external forces, excessive actuator strength, artificial floor adhesion, or disabled collisions.

Legitimate supports, assistive devices, and apparatus must be modeled and declared—not hidden.

Do not use a static balance criterion as a universal rule for dynamic movement.

Use reference motion, trajectory optimization, or physics-based imitation where appropriate. Do not assume that matching keyframes proves dynamic credibility.

5. BLENDER-TO-SIMLAB CONSISTENCY

Separate:
- Editable source assets.
- Runtime presentation assets.
- Physical model/configuration.
- Recorded simulation state and evidence.

Do not assume GLB export transfers the physics setup.

Preserve compatibility with existing bone names, bind poses, skin weights, topology-dependent features, paint atlases, saved poses, and application interfaces.

Extend round-trip checks to relevant joint transforms, skin deformation, contact events, timestamps, body variants, and host-specific behavior.

Clearly distinguish:
- Authored playback.
- Recorded simulation replay.
- Interactive recalculation.

Never display force or deformation data from an old trial as though it belongs to a changed movement.

Distinguish slow-motion viewing from recalculating a movement performed at a different physical speed.

6. REUSABLE AI-ASSISTED BLENDER TOOLS

Turn successful one-off scripts into versioned, repeatable tools.

Develop a simLAB Movement Workbench, as justified by the audit, for:
- Rig and joint inspection.
- Movement authoring and reference-motion retargeting.
- Collision/contact visualization.
- Tissue compression experiments.
- Native simulation execution and replay.
- Candidate comparison.
- Validation reports.
- Approved asset export.

Give the AI structured scene data, transforms, contact results, settings, logs, and renders—not just screenshots.

Make failures actionable: identify the first failing time, segment pair, movement phase, metric, and likely cause.

Use available local Blender automation, Python, command-line tools, or a verified MCP connection. Do not assume a connection exists.

Treat AI-driven code execution as security-sensitive. Work in isolated copies, protect credentials and patient information, and avoid simultaneous edits to the same Blender scene by multiple agents.

ADDITIONAL CAPABILITIES TO INCLUDE IN THE ROADMAP

Evaluate and prioritize these against actual educational value:
- Motion-capture import, cleanup, contact correction, and retargeting.
- Task-based authoring from goals and constraints.
- Validated variations in body proportions, targets, loads, stance, and speed.
- Clinician-defined impairment and compensation profiles.
- Muscle/tendon visualization and specialist musculoskeletal analysis.
- Reusable treatment tables, chairs, stairs, rails, walkers, weights, mats, and other equipment.
- Joint-angle traces, trajectories, contact displays, and synchronized force visualization.
- Multi-view teaching comparisons, slow motion, and anatomical overlays.
- Student-controlled experiments with clearly defined supported parameters.
- Breathing, gaze, clothing, and other presentation details kept separate from biomechanical evidence.
- Synthetic labeled datasets with licensing and model-generated provenance.
- Runtime optimization and appropriate levels of geometric and physical detail.

Do not invent disease-specific movement patterns, physiological measurements, or unsupported clinical conclusions. Verify dataset and asset licensing before incorporating them.

VALIDATION STANDARD

Create acceptance criteria before tuning each candidate.

Distinguish:
- Successful import/export.
- Numerical stability.
- Trajectory tracking.
- Contact and support acceptance.
- Anatomical appropriateness.
- Experimental validation for a defined use.
- Faithful runtime delivery.

These are separate achievements.

Test the relevant trajectory, not only its final pose. Use physics-step or appropriately dense event-aware checks for critical contact failures. Include timestep sensitivity and repeatability where relevant.

Never make a test pass by quietly loosening thresholds, increasing strength, suppressing failures, disabling relevant collisions, or relabeling incomplete work as accepted.

Preserve failed cases and explain them.

Record source revisions, asset/configuration identities, solver and Blender versions, assumptions, test commands, and outputs.

FIRST IMPLEMENTATION PRIORITY

Unless the audit establishes a more fundamental blocker, begin with one existing movement that exposes an important integration or contact problem.

Take it through the complete pipeline on both available native body variants:
1. Inspect and reproduce the baseline.
2. Identify the actual failure or divergence.
3. Define acceptance criteria.
4. Implement the smallest coherent correction.
5. Run targeted and relevant regression tests.
6. Compare numerical evidence and matched visual views.
7. Verify the delivered simLAB behavior, where execution access permits.

Then build reusable benchmark coverage for:
- Hand-on-back contact.
- Deep squat.
- Supine or side-lying support.
- Palm-supported loading.
- A simple jump and landing when the controller supports it.

Do not attempt to implement the entire vision in one unreviewable patch.

WORKING RULES

- Make reasonable, reversible engineering decisions independently.
- Prefer extending working infrastructure over replacing it.
- Protect production assets and existing saved data.
- Run inexpensive targeted checks before broad or costly jobs.
- Group changes into coherent batches rather than generating excessive tiny PRs.
- Do not merge, deploy, or perform destructive changes without explicit authorization.
- Consult current official documentation and primary research when required.
- Separate observed results, documentation claims, hypotheses, and recommendations.
- Never claim to have opened Blender, executed a simulation, passed a test, or inspected a local file unless you actually did.
- If local execution is unavailable, implement what you can and provide precise runnable commands for the unexecuted checks. Mark those checks unverified.
- Keep progress updates brief and focused on findings and decisions.

DELIVERABLES FOR THIS SESSION

Provide:
- A concise audit of the actual current architecture and highest-priority gaps.
- The bounded improvement selected and why.
- The implementation and files changed.
- Tests actually executed, results, and remaining failures.
- Before/after measurements and visual evidence where available.
- Exact instructions for opening, reproducing, and using the result.
- Remaining assumptions and unsupported claims.
- A prioritized roadmap linking the next steps to the larger vision.

Begin by inspecting the repositories and available Blender workspace. Then complete the first justified, bounded improvement end-to-end rather than stopping at recommendations.
