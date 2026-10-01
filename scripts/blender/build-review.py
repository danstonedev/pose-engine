"""Blender --background --factory-startup --python build-review.py -- <review-dir>.

Imports engine reference clips, measures bones/skin, exports a glTF round trip,
and saves a visual authoring scene with a hand IK target. Never edits source GLBs.
"""
import bpy
import hashlib
import json
import math
import sys
from pathlib import Path
from mathutils import Vector, Quaternion
from mathutils.kdtree import KDTree

folder = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf8'))
project = folder / 'movement-review.blend'
if project.exists() or (folder / 'blender-results.json').exists():
    raise RuntimeError('Use a fresh review folder; existing project/evidence is preserved')
(folder / 'roundtrip').mkdir(exist_ok=False)
(folder / 'renders').mkdir(exist_ok=False)
report = {'blenderVersion': bpy.app.version_string, 'buildHash': bpy.app.build_hash.decode(),
          'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'sourceRevision': manifest['sourceRevision'], 'toleranceM': 0.0001,
          'method': 'All reference bone heads and sampled rendered skin points at eight times per clip. Skin uses nearest evaluated vertex because import can reorder vertices. Engine render-only twist is baked. No anatomical acceptance implied.',
          'cases': []}


def engine_point(point):
    return Vector((point.x, point.z, -point.y))


def blender_point(point):
    return Vector((point[0], -point[2], point[1]))


def load_scene(case, name):
    scene = bpy.data.scenes.new(name)
    bpy.context.window.scene = scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = manifest['fps']
    bpy.ops.import_scene.gltf(filepath=str(folder / case['file']),
                             bone_heuristic='BLENDER', merge_vertices=False,
                             guess_original_bind_pose=True, import_pack_images=True)
    rigs = [obj for obj in scene.objects if obj.type == 'ARMATURE']
    if len(rigs) != 1:
        raise RuntimeError(f'Expected one rig in {case["id"]}, found {len(rigs)}')
    rig = rigs[0]
    rig.show_in_front = True
    scene['review_case'] = case['id']
    scene['review_rig'] = rig.name
    scene['review_manifest'] = str(folder / 'manifest.json')
    scene.frame_start = 0
    scene.frame_end = case['frames'] - 1
    for label, frame in [('Setup', 0), ('Approach', 66), ('Assessed hold', case['holdFrame'] - 1), ('Return', case['frames'] - 1)]:
        scene.timeline_markers.new(label, frame=frame)
    for obj in scene.objects:
        for mod in obj.modifiers:
            if mod.type == 'ARMATURE':
                # Match the engine's linear blend skinning, not Blender-only DQ.
                mod.use_deform_preserve_volume = False
    return scene, rig


def surface_tree(scene):
    graph = bpy.context.evaluated_depsgraph_get()
    points = []
    for obj in scene.objects:
        if obj.type != 'MESH':
            continue
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        points.extend(engine_point(evaluated.matrix_world @ v.co) for v in mesh.vertices)
        evaluated.to_mesh_clear()
    tree = KDTree(len(points))
    for i, p in enumerate(points):
        tree.insert(p, i)
    tree.balance()
    return tree, len(points)


def presentation(scene):
    bpy.context.window.scene = scene
    scene.world = bpy.data.worlds.new(scene.name + ' World')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.18, 0.21, 0.25, 1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.45
    camera_data = bpy.data.cameras.new(scene.name + ' rear camera')
    camera = bpy.data.objects.new(camera_data.name, camera_data)
    scene.collection.objects.link(camera)
    camera.location = (2.8, 4.0, 2.4)
    camera.rotation_euler = (Vector((0, 0, 1.08)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = 2.25
    scene.camera = camera
    for name, location, energy, size in [('Key', (3, 2, 5), 650, 4), ('Fill', (-3, 1, 3), 400, 3)]:
        data = bpy.data.lights.new(scene.name + name, 'AREA')
        data.energy, data.shape, data.size = energy, 'DISK', size
        obj = bpy.data.objects.new(data.name, data)
        obj.location = location
        obj.rotation_euler = (Vector((0, 0, 1)) - obj.location).to_track_quat('-Z', 'Y').to_euler()
        scene.collection.objects.link(obj)
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 16
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'


reference_scenes = []
for case in manifest['cases']:
    scene, rig = load_scene(case, 'Reference ' + case['id'])
    data = json.loads((folder / case['expected']).read_text())
    measurements = []
    for expected in data['expected']:
        # glTF time zero imports at Blender frame 0, independently of frame_start.
        scene.frame_set(expected['frame'] - 1)
        bpy.context.view_layer.update()
        tree, count = surface_tree(scene)
        missing = [name for name in expected['bones'] if name not in rig.pose.bones]
        if missing:
            raise RuntimeError(f'Missing bone names: {missing}')
        bone_errors = {name: (engine_point(rig.matrix_world @ rig.pose.bones[name].matrix.translation) - Vector(p)).length
                       for name, p in expected['bones'].items()}
        skin_error = max(tree.find(Vector(p))[2] for p in expected['skinPointsM'])
        measurements.append({'timeSec': expected['timeSec'], 'frame': scene.frame_current,
                             'maxBoneErrorM': max(bone_errors.values()), 'maxSkinNearestVertexErrorM': skin_error,
                             'worstBone': max(bone_errors, key=bone_errors.get), 'evaluatedVertices': count})
    result = {'id': case['id'], 'checkpoints': measurements,
              'maxBoneErrorM': max(p['maxBoneErrorM'] for p in measurements),
              'maxSkinErrorM': max(p['maxSkinNearestVertexErrorM'] for p in measurements)}
    result['passed'] = max(result['maxBoneErrorM'], result['maxSkinErrorM']) <= report['toleranceM']
    report['cases'].append(result)
    print('PARITY', json.dumps(result), flush=True)
    # Export references before adding any presentation objects or authoring controls.
    scene.frame_start = 0
    scene.frame_end = case['frames'] - 1
    scene.frame_set(0)
    bpy.ops.export_scene.gltf(filepath=str(folder / 'roundtrip' / case['file']), export_format='GLB',
                              use_active_scene=True, export_animations=True, export_animation_mode='SCENE',
                              export_force_sampling=True, export_frame_range=True, export_frame_step=1,
                              export_optimize_animation_size=False, export_rest_position_armature=True,
                              export_yup=True, export_skins=True, export_all_influences=True,
                              export_cameras=False, export_lights=False)
    scene.frame_set(case['holdFrame'] - 1)
    presentation(scene)
    reference_scenes.append((case, scene))

# A separate authoring scene keeps the sampled reference clip available unchanged.
case = manifest['cases'][0]
scene, rig = load_scene(case, 'Author male-L hand target')
scene.frame_set(case['holdFrame'] - 1)
bpy.context.view_layer.update()
object_locals = {obj: obj.matrix_basis.copy() for obj in scene.objects}
bone_locals = {bone.name: bone.matrix_basis.copy() for bone in rig.pose.bones}
for obj in scene.objects:
    obj.animation_data_clear()
scene.frame_set(0)
for obj, matrix in object_locals.items():
    obj.matrix_basis = matrix
for name, matrix in bone_locals.items():
    rig.pose.bones[name].matrix_basis = matrix
bpy.context.view_layer.update()
hand = rig.pose.bones['CC_Base_L_Hand']
original = rig.matrix_world @ hand.matrix.translation
goal = bpy.data.objects.new('MOVE ME - left wrist target', None)
goal.empty_display_type = 'SPHERE'
goal.empty_display_size = 0.035
goal.show_in_front = True
goal.location = original
scene.collection.objects.link(goal)
# glTF bone display tails are not the anatomical segment endpoints. Build a
# non-deforming control chain through the actual shoulder/elbow/wrist heads.
# Offset targets retain the imported deform bones' original coordinate frames.
names = ['CC_Base_L_Clavicle', 'CC_Base_L_Upperarm', 'CC_Base_L_Forearm']
world_matrices = {name: rig.matrix_world @ rig.pose.bones[name].matrix for name in names}
hand_world = rig.matrix_world @ hand.matrix
control_data = bpy.data.armatures.new('Reach authoring controls')
controls = bpy.data.objects.new('Reach authoring controls', control_data)
scene.collection.objects.link(controls)
controls.show_in_front = True
bpy.ops.object.select_all(action='DESELECT')
controls.select_set(True)
bpy.context.view_layer.objects.active = controls
bpy.ops.object.mode_set(mode='EDIT')
control_names = ['Clavicle', 'Upper arm', 'Forearm']
points = [world_matrices[name].translation for name in names] + [original]
previous = None
for index, name in enumerate(control_names):
    bone = control_data.edit_bones.new(name)
    bone.head, bone.tail = points[index], points[index + 1]
    bone.use_deform = False
    if previous:
        bone.parent = previous
        bone.use_connect = True
    previous = bone
bpy.ops.object.mode_set(mode='OBJECT')
for bone in controls.pose.bones:
    bone.ik_stretch = 0
ik = controls.pose.bones['Forearm'].constraints.new('IK')
ik.name = 'Wrist target - no stretch'
ik.target = goal
ik.chain_count = 2
ik.use_tail = True
ik.use_stretch = False
ik.iterations = 128
bpy.context.view_layer.update()
for control_name, deform_name in zip(control_names, names):
    target = bpy.data.objects.new('Frame offset - ' + control_name, None)
    scene.collection.objects.link(target)
    target.parent = controls
    target.parent_type = 'BONE'
    target.parent_bone = control_name
    target.empty_display_size = 0.008
    target.hide_set(True)
    bpy.context.view_layer.update()
    target.matrix_world = world_matrices[deform_name]
    copy = rig.pose.bones[deform_name].constraints.new('COPY_ROTATION')
    copy.name = 'Follow authoring control with source-frame offset'
    copy.target = target
    copy.target_space = 'WORLD'
    copy.owner_space = 'WORLD'
goal.rotation_mode = 'QUATERNION'
goal.rotation_quaternion = hand_world.to_quaternion()
copy = hand.constraints.new('COPY_ROTATION')
copy.name = 'Wrist target orientation'
copy.target = goal
copy.target_space = 'WORLD'
copy.owner_space = 'WORLD'
bpy.context.view_layer.update()
initial_error = ((rig.matrix_world @ hand.matrix.translation) - original).length
held_reference = next(item for item in json.loads((folder / case['expected']).read_text())['expected'] if abs(item['timeSec'] - 4.1) < 0.001)
initial_bone_error = max((engine_point(rig.matrix_world @ rig.pose.bones[name].matrix.translation) - Vector(point)).length for name, point in held_reference['bones'].items())
initial_tree, _ = surface_tree(scene)
initial_skin_error = max(initial_tree.find(Vector(point))[2] for point in held_reference['skinPointsM'])
goal.location.x += 0.03
bpy.context.view_layer.update()
moved = rig.matrix_world @ hand.matrix.translation
movement = (moved - original).length
target_error = (moved - goal.location).length
goal.location.x -= 0.03
bpy.context.view_layer.update()
report['authoring'] = {'scene': scene.name, 'target': goal.name, 'chain': control_names,
                      'initialWristErrorM': initial_error, 'testTargetOffsetM': 0.03,
                      'initialMaxBoneErrorM': initial_bone_error, 'initialMaxSkinErrorM': initial_skin_error,
                      'wristMovementM': movement, 'testTargetErrorM': target_error,
                      'clinicalLimitsMapped': False, 'note': 'Visual IK authoring only. Anatomical segment endpoints define the separate control chain, stretching is disabled, and source bone frames are retained via offsets. Engine joint/capacity/clearance validation remains required.'}
presentation(scene)
scene['review_authoring'] = True
rig.show_in_front = False
bpy.ops.object.select_all(action='DESELECT')
goal.select_set(True)
bpy.context.view_layer.objects.active = goal
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            space = area.spaces.active
            space.region_3d.view_perspective = 'CAMERA'
            space.shading.type = 'SOLID'
readme = bpy.data.texts.new('START HERE - movement review')
readme.write('''MOVEMENT REVIEW — Blender reference + visual authoring

Use the Scene selector at the top right:
  Reference male/female/neutral-L/R: the actual engine animation, including twist helpers.
  Author male-L hand target: an editable copy at the assessed hold.

In the Author scene the wrist target is selected. G moves it; X/Y/Z constrains
movement; R changes palm orientation. The arm IK has stretching disabled. Select
Reach authoring controls, enter Pose Mode and rotate Clavicle to explore shoulder
coordination. These visual controls DO NOT enforce the
engine's clinical ROM or proxy capacity policy. A reachable IK target is not an
accepted movement. Reference scenes retain the original animation and weights.

The camera looks from behind to expose hand/back clearance. Numpad 0 toggles
camera view. Reference timeline markers identify setup, approach and hold.
Use solid shading for fast inspection, material/render view for surface review.

To export an edit, keep the Author scene active, switch an area to Text Editor,
choose EXPORT CURRENT AUTHOR SCENE and Run Script (Alt+P). A fresh candidate
folder beside this project contains the baked GLB and Blender measurements.
Run verify-roundtrip.ts on that folder to check its replay in the engine.

Source models were copied into neutral review materials. Production files were
not modified. Read manifest.json, blender-results.json and the engine round-trip
report beside this project for provenance and measured import/export limits.
''')
export_text = bpy.data.texts.new('EXPORT CURRENT AUTHOR SCENE')
export_text.write(Path(__file__).with_name('export-active.py').read_text(encoding='utf8'))
# Remove the empty factory scene only; imported references are retained separately.
factory = bpy.data.scenes.get('Scene')
if factory and factory != scene:
    bpy.data.scenes.remove(factory)
bpy.ops.wm.save_as_mainfile(filepath=str(project))
(folder / 'blender-results.json').write_text(json.dumps(report, indent=2) + '\n')
for case, reference in reference_scenes:
    if case['side'] == 'L':
        bpy.context.window.scene = reference
        reference.render.filepath = str(folder / 'renders' / (case['id'] + '-rear.png'))
        bpy.ops.render.render(write_still=True)
if not all(case['passed'] for case in report['cases']):
    raise RuntimeError('Blender reference import differs from engine; inspect preserved evidence')
if initial_error > 0.001 or movement < 0.02 or target_error > 0.002 or max(initial_bone_error, initial_skin_error) > report['toleranceM']:
    raise RuntimeError('Authoring IK check failed; inspect preserved project and report')
print('BLENDER_REVIEW_READY', str(project), flush=True)
