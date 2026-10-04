"""Author a measured whole-chain press-up proposal on the actual production rigs.

Blender --background --factory-startup --python-exit-code 1 --python <script> --
  <candidate2-review> <chain-audit-with-transforms.json> <fresh-output>

This is an editable geometric proposal, not a clinical/native acceptance result.
Existing source animation, constraints and gates are never edited. Skin contacts
are chosen explicitly; forearm IK here has no clinical clamp and is reported as
such. Its reconstructed engine local quaternions permit a separate bounded check.
"""
import bpy
import hashlib
import json
import math
import sys
from pathlib import Path
from mathutils import Vector, Quaternion, Matrix, Euler
import numpy as np

source, audit_path, output = map(lambda p: Path(p).resolve(), sys.argv[sys.argv.index('--') + 1:])
output.mkdir()
manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8-sig'))
audit = json.loads(audit_path.read_text(encoding='utf-8-sig'))
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
C = Quaternion((1, 0, 0), math.pi / 2)
def qxyzw(v): return Quaternion((v[3], v[0], v[1], v[2]))
def xyzw(q): return [float(q.x), float(q.y), float(q.z), float(q.w)]
def ep(v): return [float(v.x), float(v.z), float(-v.y)]
def bp(v): return Vector((v[0], -v[2], v[1]))
report = {'schemaVersion': 1, 'blenderVersion': bpy.app.version_string,
          'blenderBuildHash': bpy.app.build_hash.decode(), 'scriptSha256': sha(Path(__file__)),
          'sourceManifestSha256': sha(source / 'manifest.json'), 'sourceProjectSha256': sha(source / 'full-motion-review.blend'),
          'sourceDigest': manifest['sourceDigest'], 'auditSha256': sha(audit_path), 'floorY': 0,
          'scope': 'Editable Blender geometric whole-chain proposal. No clinical clamp, native dynamics, force, compression or host acceptance is implied.',
          'predeclaredProposal': {'peakLumbarFlexionDeg': -12, 'peakThoracicFlexionDeg': -23,
              'reason': 'Redistribute existing 35 degrees total trunk excursion across lumbar and both thoracic segments; do not add lumbar extension.',
              'girdleUpRotationDeg': 10, 'girdleScapularTiltDeg': 0, 'girdleProtractionDeg': 0,
              'girdleReason': 'Editable modest symmetric source proxy pose; remove support-driven 40-60 degree girdle compensation before solving elbows.',
              'elbowGuide': 'Feetward from shoulder, small outward component (0.2 upper-arm lengths); fit smallest upward component in 0..1 lengths that clears actual arm skin by1mm.',
              'lowerBodySupport': 'Pelvis skin at world zero, recalculated after spinal/hip changes. Per-side hip pitch puts lowest toe/dorsal toe skin at zero; knee/ankle/toe local rotations remain source values.',
              'setupChestClearance': 'If supported pelvis would penetrate chest, fit minimum symmetric thoracic extension (0..12 deg) that restores >=0 clearance; report failure if not attainable.'},
          'phaseSource': 'Source recipe: prepared setup 0..1s, extension1..2.5s, hold2.5..4.1s, return4.1..5.4s. No clinical scoring phase claim.',
          'cases': []}
bpy.ops.wm.open_mainfile(filepath=str(source / 'full-motion-review.blend'))

def world(rig, bone): return rig.matrix_world @ bone.matrix
def rotate_world(rig, bone, rotation):
    m = world(rig, bone)
    bone.matrix = rig.matrix_world.inverted() @ Matrix.LocRotScale(m.translation, rotation @ m.to_quaternion(), m.to_scale())
    bpy.context.view_layer.update()

def control(scene, name, point, size=.035):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type, obj.empty_display_size = 'SPHERE', size
    scene.collection.objects.link(obj)
    obj.location = point
    obj.show_in_front = True
    return obj

for case in manifest['cases']:
    source_row = next(c for c in audit['cases'] if c['id'] == case['id'])
    scene = bpy.data.scenes['Review ' + case['id']]
    scene.name = 'Author whole chain ' + case['variant']
    bpy.context.window.scene = scene
    rig = next(o for o in scene.objects if o.type == 'ARMATURE')
    root = next(o for o in scene.objects if o.name.startswith('ENGINE_ModelRoot'))
    fps = manifest['fps']
    meshes = []
    for obj in scene.objects:
        if obj.type != 'MESH' or not any(m.type == 'ARMATURE' and m.object == rig for m in obj.modifiers): continue
        groups = {g.index: g.name for g in obj.vertex_groups}
        owners = [groups[max(v.groups, key=lambda g: g.weight).group] if v.groups else '' for v in obj.data.vertices]
        regions = {'pelvis': [i for i, n in enumerate(owners) if n in ['CC_Base_Hip', 'CC_Base_Pelvis']],
                   'torso': [i for i, n in enumerate(owners) if any(k in n for k in ['Waist', 'Spine', 'Breast', 'Ribs'])],
                   'head': [i for i, n in enumerate(owners) if 'Head' in n or 'Neck' in n]}
        for side in ['L', 'R']:
            hand = rig.data.bones['CC_Base_' + side + '_Hand']
            hand_names = {hand.name, *(b.name for b in hand.children_recursive)}
            regions[side + ' hand'] = [i for i, n in enumerate(owners) if n in hand_names]
            regions[side + ' toes'] = [i for i, n in enumerate(owners) if '_' + side + '_' in n and 'Toe' in n]
            regions[side + ' leg'] = [i for i, n in enumerate(owners) if '_' + side + '_' in n and any(k in n for k in ['Thigh', 'Calf'])]
            regions[side + ' foot'] = [i for i, n in enumerate(owners) if n == 'CC_Base_' + side + '_Foot']
            regions[side + ' arm'] = [i for i, n in enumerate(owners) if '_' + side + '_' in n and any(k in n for k in ['Forearm', 'Upperarm'])]
        meshes.append((obj, {name: np.array(ids, dtype=np.int32) for name, ids in regions.items()}, owners))
    last_witness = {}
    def minima():
        result = {}
        graph = bpy.context.evaluated_depsgraph_get()
        for obj, masks, owners in meshes:
            evaluated = obj.evaluated_get(graph); mesh = evaluated.to_mesh()
            coords = np.empty(len(mesh.vertices) * 3); mesh.vertices.foreach_get('co', coords)
            matrix = np.array(evaluated.matrix_world)
            points = coords.reshape((-1, 3)) @ matrix[:3, :3].T + matrix[:3, 3]
            for region, ids in masks.items():
                if len(ids): result[region] = min(result.get(region, math.inf), float(np.min(points[ids, 2])))
            index = int(np.argmin(points[:, 2]))
            if points[index, 2] < result.get('all', math.inf):
                result['all'] = float(points[index, 2])
                last_witness.clear(); last_witness.update({'mesh': obj.name, 'vertexIndex': index,
                    'dominantBone': owners[index], 'positionM': [float(points[index, 0]), float(points[index, 2]), float(-points[index, 1])], 'pair': owners[index] + '/world-zero floor'})
            evaluated.to_mesh_clear()
        return result
    # Capture before editing actions. Baking writes a fresh action, including all
    # originally exported helper/twist tracks, instead of modifying source keys.
    originals = []
    for index in range(case['frames']):
        scene.frame_set(index); bpy.context.view_layer.update()
        originals.append({'basis': {b.name: b.matrix_basis.copy() for b in rig.pose.bones},
            'world': {b.name: world(rig, b).copy() for b in rig.pose.bones},
            'rootBasis': root.matrix_basis.copy(), 'rootWorld': root.matrix_world.copy()})
    for obj in [rig, root]:
        obj.animation_data_clear()
    def reset(index):
        root.matrix_basis = originals[index]['rootBasis']
        for bone in rig.pose.bones: bone.matrix_basis = originals[index]['basis'][bone.name]
        bpy.context.view_layer.update()
    def bone(key): return rig.pose.bones[source_row['frames'][0]['boneTransforms'][key]['name']]
    def set_engine_local(index, key, desired):
        data = source_row['frames'][index]['boneTransforms'][key]
        pb = bone(key)
        parent_engine = qxyzw(data['parentWorldQuaternion'])
        local_difference = desired @ qxyzw(data['localQuaternion']).inverted()
        diff_world = C @ parent_engine @ local_difference @ parent_engine.inverted() @ C.inverted()
        parent_before = originals[index]['world'][pb.parent.name].to_quaternion()
        parent_now = world(rig, pb.parent).to_quaternion()
        moved_parent = parent_now @ parent_before.inverted()
        rotate_world(rig, pb, moved_parent @ diff_world @ moved_parent.inverted())
    def set_flexion(index, key, degrees):
        rest = qxyzw(source_row['restReference']['localQuats'][key])
        set_engine_local(index, key, Quaternion((1, 0, 0), math.radians(degrees)) @ rest)
    setup = case['setupFrame']
    reset(setup)
    wrist_targets = {side: world(rig, bone(side + '_Hand')).copy() for side in ['L', 'R']}
    pelvis_anchor = world(rig, bone('Hips')).translation.copy()
    setup_original = minima()
    # The pelvis height is an explicit skin anchor; this is not a generic
    # floor-clearance lift. The arms will be resolved back to fixed palm targets.
    pelvis_anchor.z -= setup_original['pelvis']
    def support_pelvis():
        difference = pelvis_anchor.z - world(rig, bone('Hips')).translation.z
        root.location.z += difference
        bpy.context.view_layer.update()
    def set_spine(index, base_extension):
        p = max(0, min(1, -source_row['frames'][index]['segments']['Spine_Lower']['flexion'] / 20))
        set_flexion(index, 'Spine_Lower', -12 * p)
        thoracic = -base_extension * (1 - p) - 23 * p
        set_flexion(index, 'Spine_Mid', thoracic / 2)
        set_flexion(index, 'Spine_Upper', thoracic / 2)
    # Minimum added setup thoracic extension to avoid breast/chest penetration
    # after meaningful pelvic support. The final total remains 35 degrees.
    chest_search = []
    for extension in range(13):
        reset(setup); set_spine(setup, extension); support_pelvis()
        clearance = minima()['torso']; chest_search.append({'thoracicExtensionDeg': extension, 'torsoMinimumM': clearance})
        if clearance >= -0.0001: break
    base_extension = extension
    # Resting distal contact from mesh geometry. Keep the knee/ankle/toe source
    # angles; choose a small hip pitch that meets the toe support plane.
    hip_pitch = {}
    for side in ['L', 'R']:
        reset(setup); set_spine(setup, base_extension); support_pelvis()
        pb = bone(side + '_UpLeg'); start = pb.matrix_basis.copy()
        low, high = -8.0, 8.0
        candidates = []
        for degrees in np.linspace(low, high, 65):
            pb.matrix_basis = start; bpy.context.view_layer.update()
            rotate_world(rig, pb, Quaternion((1, 0, 0), math.radians(float(degrees))))
            clearance = minima()[side + ' toes']; candidates.append((abs(clearance), float(degrees), clearance))
        best = min(candidates)
        hip_pitch[side] = {'worldPitchDeg': best[1], 'toeClearanceM': best[2], 'searchRangeDeg': [low, high]}
    row = {'id': case['id'], 'variant': case['variant'], 'sourceModelSha256': case['sourceModelSha256'],
           'sourceGlbSha256': case['glbSha256'], 'durationMs': case['durationMs'], 'sampleHz': fps,
           'setupSkinBeforeM': setup_original, 'setupThoracicSearch': chest_search,
           'setupThoracicExtensionDeg': base_extension, 'hipPitch': hip_pitch,
           'pelvisBoneAnchorM': ep(pelvis_anchor), 'handBoneAnchorsM': {s: ep(m.translation) for s, m in wrist_targets.items()},
           'clinicalStatus': 'Not yet checked; geometric IK is unconstrained. No runtime change or bounds relaxation.', 'frames': []}
    controls = {key: control(scene, key, point) for key, point in [
        ('CONTACT pelvis skin-derived bone anchor', pelvis_anchor),
        *[('CONTACT ' + side + ' fixed palm wrist', m.translation) for side, m in wrist_targets.items()]]}
    for index in range(case['frames']):
        scene.frame_set(index); reset(index)
        set_spine(index, base_extension); support_pelvis()
        hip_basis = {s: bone(s + '_UpLeg').matrix_basis.copy() for s in ['L', 'R']}
        fitted_hips = {}
        for iteration in range(2):
            # A pelvic skin point is not rigidly tied to the root: its weighted
            # surface changes during spinal extension. Resolve that contact,
            # then respond at each hip to retain distal toe support.
            root.location.z -= minima()['pelvis']; bpy.context.view_layer.update()
            for side in ['L', 'R']:
                pb = bone(side + '_UpLeg')
                lo, hi = -8.0, 8.0
                for step in range(13):
                    degrees = (lo + hi) / 2
                    pb.matrix_basis = hip_basis[side]; bpy.context.view_layer.update()
                    rotate_world(rig, pb, Quaternion((1, 0, 0), math.radians(degrees)))
                    if minima()[side + ' toes'] < 0: lo = degrees
                    else: hi = degrees
                fitted_hips[side] = degrees
        arm_fits = {}
        for side in ['L', 'R']:
            # Girdle angles use the existing engine parent-YXZ convention.
            rest = qxyzw(source_row['restReference']['localQuats'][side + '_Shoulder'])
            set_engine_local(index, side + '_Shoulder', Quaternion((0, 0, 1), math.radians(10 if side == 'L' else -10)) @ rest)
            upper, forearm, hand = (bone(side + '_' + part) for part in ['UpperArm', 'Forearm', 'Hand'])
            start_arm = {pb.name: pb.matrix_basis.copy() for pb in [upper, forearm, hand]}
            def arm_candidate(upward):
                for pb in [upper, forearm, hand]: pb.matrix_basis = start_arm[pb.name]
                bpy.context.view_layer.update()
                shoulder = world(rig, upper).translation; elbow = world(rig, forearm).translation
                wrist = world(rig, hand).translation; target = wrist_targets[side].translation
                a, b = (elbow - shoulder).length, (wrist - elbow).length
                reach = target - shoulder; d = reach.length; axis = reach.normalized()
                if d > a + b or d < abs(a - b): raise RuntimeError('Unreachable fixed palm for ' + case['id'])
                along = (a*a - b*b + d*d) / (2*d)
                pole = Vector((.2 * a * (1 if side == 'L' else -1), a, upward * a))
                perpendicular = (pole - axis * pole.dot(axis)).normalized()
                desired_elbow = shoulder + axis * along + perpendicular * math.sqrt(max(0, a*a - along*along))
                rotate_world(rig, upper, (elbow - shoulder).rotation_difference(desired_elbow - shoulder))
                elbow = world(rig, forearm).translation; wrist = world(rig, hand).translation
                rotate_world(rig, forearm, (wrist - elbow).rotation_difference(target - elbow))
                hand_matrix = world(rig, hand)
                hand.matrix = rig.matrix_world.inverted() @ Matrix.LocRotScale(hand_matrix.translation, wrist_targets[side].to_quaternion(), hand_matrix.to_scale())
                bpy.context.view_layer.update()
                return desired_elbow, minima()[side + ' arm']
            desired_elbow, arm_clearance = arm_candidate(0)
            upward = 0
            if arm_clearance < .001:
                lo, hi = 0.0, 1.0
                for step in range(9):
                    upward = (lo + hi) / 2
                    desired_elbow, arm_clearance = arm_candidate(upward)
                    if arm_clearance < .001: lo = upward
                    else: hi = upward
                upward = hi
                desired_elbow, arm_clearance = arm_candidate(upward)
            arm_fits[side] = {'upwardUpperArmLengths': upward, 'minimumArmSkinM': arm_clearance}
            guide_key = 'GUIDE ' + side + ' elbow feetward'
            if guide_key not in controls: controls[guide_key] = control(scene, guide_key, desired_elbow)
            controls[guide_key].location = desired_elbow
            controls[guide_key].keyframe_insert('location', frame=index)
        positions, local_quats = {}, {}
        for key, data in source_row['frames'][index]['boneTransforms'].items():
            pb = bone(key)
            current = world(rig, pb); baseline = originals[index]['world'][pb.name]
            delta = current.to_quaternion() @ baseline.to_quaternion().inverted()
            engine_world = C.inverted() @ delta @ C @ qxyzw(data['worldQuaternion'])
            if pb.parent:
                parent_delta = world(rig, pb.parent).to_quaternion() @ originals[index]['world'][pb.parent.name].to_quaternion().inverted()
                parent_engine = C.inverted() @ parent_delta @ C @ qxyzw(data['parentWorldQuaternion'])
            else: parent_engine = qxyzw(data['parentWorldQuaternion'])
            local_quats[key] = xyzw(parent_engine.inverted() @ engine_world)
            positions[key] = ep(current.translation)
        limits = minima()
        row['frames'].append({'sampleIndex': index, 'timeSec': index / fps, 'skinMinimaM': limits, 'minimumWitness': dict(last_witness),
            'fittedHipWorldPitchDeg': fitted_hips, 'fittedElbowGuide': arm_fits,
            'bonePositionsM': positions, 'engineLocalQuaternions': local_quats,
            'wristPositionResidualM': {side: (world(rig, bone(side + '_Hand')).translation - target.translation).length for side, target in wrist_targets.items()}})
        for pb in rig.pose.bones:
            pb.keyframe_insert('location', frame=index); pb.keyframe_insert('rotation_quaternion', frame=index); pb.keyframe_insert('scale', frame=index)
        for path in ['location', 'rotation_quaternion', 'scale']: root.keyframe_insert(path, frame=index)
    for obj in [rig, root]:
        if obj.animation_data and obj.animation_data.action: obj.animation_data.action.name = 'AUTHORED whole-chain ' + case['variant'] + ' ' + obj.name
    scene.frame_set(case['holdFrame'] - 1)
    for obj in controls.values(): obj.hide_render = True
    scene['whole_chain_proposal_scope'] = row['clinicalStatus']
    scene['lumbar_peak_degrees'], scene['thoracic_peak_degrees'] = -12, -23
    scene['setup_thoracic_extension_degrees'] = base_extension
    report['cases'].append(row)
    print(case['variant'], 'base thoracic', base_extension, 'hip', hip_pitch, 'worst skin', min(f['skinMinimaM']['all'] for f in row['frames']), flush=True)

bpy.ops.wm.save_as_mainfile(filepath=str(output / 'whole-chain-authoring.blend'))
report['projectSha256'] = sha(output / 'whole-chain-authoring.blend')
(output / 'whole-chain-authoring.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
