"""Fit editable quadruped knee/dorsal-foot support proposals from retained skin.

This is a static setup/peak authoring diagnostic, not a runtime correction.
Blender --background --factory-startup --python-exit-code 1 --python THIS --
  <retained-review-folder> <fresh-output-folder>
"""
import bpy
import hashlib
import json
import math
import sys
from pathlib import Path
from mathutils import Matrix, Vector
import numpy as np

source, output = (Path(x).resolve() for x in sys.argv[sys.argv.index('--') + 1:][:2])
output.mkdir()
manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8-sig'))
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
ep = lambda point: [float(point[0]), float(point[2]), -float(point[1])]
report = {
    'version': 1, 'blenderVersion': bpy.app.version_string,
    'sourceDigest': manifest['sourceDigest'],
    'sourceManifestSha256': sha(source / 'manifest.json'),
    'sourceProjectSha256': sha(source / 'full-motion-review.blend'),
    'scriptSha256': sha(Path(__file__)), 'floorY': 0,
    'scope': 'Static actual-skin authoring proposal only. Same local joint rotations; sagittal root orientation and translation fit knee and dorsal-foot skin. No full-cycle, palm stability, clinical or native acceptance.',
    'criteriaBeforeFit': [
        'Keep all imported local bone rotations and body proportions unchanged.',
        'Find a sagittal orientation at which measured knee-helper skin and foot-descendant skin can share world-zero support.',
        'Report full lower-limb minima rather than hiding calf penetration or knee floating.',
        'Report changed hand, head and pelvis locations so a subsequent contact solve cannot assume unchanged hand support.'
    ], 'cases': []}
bpy.ops.wm.open_mainfile(filepath=str(source / 'full-motion-review.blend'))

def material(name, color):
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*color, 1)
    return result

floor_material = material('Explicit world-zero plane', (.26, .30, .33))
control_material = material('Editable measured support proposal', (.04, .7, .85))

def add_control(name, point):
    control = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(control)
    control.location = point
    control.empty_display_type = 'SPHERE'
    control.empty_display_size = .015
    control.show_in_front = True
    control['scope'] = 'Measured support witness; move as an authoring target. No hidden force or mesh deformation.'
    return control

def evaluated_points(rig):
    graph = bpy.context.evaluated_depsgraph_get()
    regions = {key: [] for key in ['knee', 'foot', 'calf', 'hand', 'all']}
    feet = set()
    hands = set()
    for side in ['L', 'R']:
        for part, target in [('Foot', feet), ('Hand', hands)]:
            bone = rig.data.bones['CC_Base_' + side + '_' + part]
            target.update([bone.name, *(child.name for child in bone.children_recursive)])
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or not any(mod.type == 'ARMATURE' and mod.object == rig for mod in obj.modifiers):
            continue
        groups = {group.index: group.name for group in obj.vertex_groups}
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        if len(mesh.vertices) != len(obj.data.vertices):
            raise RuntimeError('Evaluated skin topology changed')
        for vertex in obj.data.vertices:
            if not vertex.groups:
                continue
            bone = groups[max(vertex.groups, key=lambda value: value.weight).group]
            point = evaluated.matrix_world @ mesh.vertices[vertex.index].co
            regions['all'].append(tuple(point))
            if 'KneeShareBone' in bone:
                regions['knee'].append(tuple(point))
            if bone in feet:
                regions['foot'].append(tuple(point))
            if 'Calf' in bone:
                regions['calf'].append(tuple(point))
            if bone in hands:
                regions['hand'].append(tuple(point))
        evaluated.to_mesh_clear()
    return {name: np.array(points, dtype=np.float64) for name, points in regions.items()}

for case in manifest['cases']:
    if case['movement'] != 'flexion-clearing':
        continue
    if sha(source / case['file']) != case['glbSha256']:
        raise RuntimeError('Source GLB changed')
    for phase, seconds in [('setup', 0), ('peak', 2.6)]:
        scene = bpy.data.scenes.new('Author support ' + case['variant'] + ' ' + phase)
        bpy.context.window.scene = scene
        scene.render.fps = manifest['fps']
        bpy.ops.import_scene.gltf(filepath=str(source / case['file']), bone_heuristic='BLENDER', guess_original_bind_pose=True)
        actor_objects = list(scene.objects)
        rig = next(obj for obj in actor_objects if obj.type == 'ARMATURE')
        for obj in actor_objects:
            for modifier in obj.modifiers:
                if modifier.type == 'ARMATURE':
                    modifier.use_deform_preserve_volume = False
        frame = seconds * manifest['fps']
        scene.frame_set(math.floor(frame), subframe=frame - math.floor(frame))
        bpy.context.view_layer.update()
        # Freeze sampled channels before exposing static editable scene controls.
        object_basis = {obj: obj.matrix_basis.copy() for obj in actor_objects}
        bone_basis = {bone.name: bone.matrix_basis.copy() for bone in rig.pose.bones}
        for obj in actor_objects:
            obj.animation_data_clear()
            obj.matrix_basis = object_basis[obj]
        for name, matrix in bone_basis.items():
            rig.pose.bones[name].matrix_basis = matrix
        bpy.context.view_layer.update()
        points = evaluated_points(rig)
        bone_names = ['Hip', 'Waist', 'Spine01', 'Spine02', 'NeckTwist01', 'NeckTwist02', 'Head',
                      'L_Thigh', 'L_Calf', 'L_Foot', 'L_Hand', 'R_Thigh', 'R_Calf', 'R_Foot', 'R_Hand']
        bones_before = {name: rig.matrix_world @ rig.pose.bones['CC_Base_' + name].matrix.translation
                        for name in bone_names if 'CC_Base_' + name in rig.pose.bones}
        pivot = (bones_before['L_Calf'] + bones_before['R_Calf']) / 2
        pivot_array = np.array(pivot)
        relative = {key: value - pivot_array for key, value in points.items()}

        def rotated(key, radians):
            rotation = np.array(Matrix.Rotation(radians, 3, 'X'))
            return relative[key] @ rotation.T + pivot_array

        def residual(radians):
            return float(rotated('foot', radians)[:, 2].min() - rotated('knee', radians)[:, 2].min())

        # Search a stated geometric interval, selecting the smallest orientation
        # change with a sign-bracketed common skin support, not a body offset table.
        angles = np.radians(np.linspace(-45, 45, 181))
        brackets = [(a, b) for a, b in zip(angles[:-1], angles[1:]) if residual(a) * residual(b) <= 0]
        if not brackets:
            raise RuntimeError('No common skin support found within geometric proposal range')
        roots = []
        for lo, hi in brackets:
            for _ in range(45):
                middle = (lo + hi) / 2
                if residual(lo) * residual(middle) <= 0:
                    hi = middle
                else:
                    lo = middle
            roots.append((lo + hi) / 2)
        angle = min(roots, key=abs)
        knee_min = float(rotated('knee', angle)[:, 2].min())
        lift = -knee_min
        transform = Matrix.Translation(Vector((0, 0, lift))) @ Matrix.Translation(pivot) @ Matrix.Rotation(angle, 4, 'X') @ Matrix.Translation(-pivot)
        for obj in actor_objects:
            if obj.parent is None:
                obj.matrix_world = transform @ obj.matrix_world
        bpy.context.view_layer.update()
        after = evaluated_points(rig)
        bones_after = {name: rig.matrix_world @ rig.pose.bones['CC_Base_' + name].matrix.translation for name in bones_before}
        for region in ['knee', 'foot']:
            values = after[region]
            witness = values[int(np.argmin(values[:, 2]))]
            add_control(region + ' world-zero skin witness', Vector(witness))
        for side in ['L', 'R']:
            add_control(side + ' knee joint control', bones_after[side + '_Calf'])
            add_control(side + ' ankle control', bones_after[side + '_Foot'])
            add_control(side + ' original palm owner', bones_before[side + '_Hand'])
        row = {'id': case['id'] + '-' + phase, 'phase': phase, 'sourceTimeSec': seconds,
               'engineReferenceY': case['floorY'], 'worldFloorY': 0,
               'rootDeltaPitchDeg': math.degrees(angle), 'rootVerticalTranslationM': lift,
               'pivotEngineM': ep(pivot), 'transformBlenderRowMajor': [list(value) for value in transform],
               'before': {key: float(value[:, 2].min()) for key, value in points.items()},
               'after': {key: float(value[:, 2].min()) for key, value in after.items()},
               'jointPositionsBeforeEngineM': {name: ep(point) for name, point in bones_before.items()},
               'jointPositionsAfterEngineM': {name: ep(point) for name, point in bones_after.items()},
               'unchangedLocalRotations': True,
               'limitation': 'Arms are not re-solved in this geometric proposal; changed palm height and world positions remain a correction requirement.'}
        report['cases'].append(row)
        bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
        bpy.context.object.name = 'Explicit world-zero support plane'
        bpy.context.object.data.materials.append(floor_material)
        scene.render.engine = 'BLENDER_WORKBENCH'
        scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 900, 650, 100
        scene.render.image_settings.file_format = 'PNG'
        scene.display.shading.light = 'STUDIO'
        scene.display.shading.color_type = 'MATERIAL'
        scene.display.shading.show_shadows = True
        scene.display.shading.show_cavity = True
        scene.display.shading.cavity_type = 'BOTH'
        scene.display.shading.background_type = 'WORLD'
        scene.world = bpy.data.worlds.new(row['id'] + ' world')
        scene.world.color = (.12, .14, .16)
        low, high = after['all'].min(axis=0), after['all'].max(axis=0)
        center = Vector((low + high) / 2)
        for view, offset in [('Side', (1, -.15, .3)), ('Overhead', (0, -.01, 1))]:
            camera = bpy.data.objects.new(view + ' camera', bpy.data.cameras.new(view))
            scene.collection.objects.link(camera)
            camera.location = center + Vector(offset) * 3
            camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
            camera.data.type, camera.data.ortho_scale = 'ORTHO', 2.15
            scene.camera = camera
            scene.render.filepath = str(output / (row['id'] + '-' + view.lower() + '.png'))
            bpy.ops.render.render(write_still=True)
        scene.camera = next(obj for obj in scene.objects if obj.type == 'CAMERA' and obj.name.startswith('Side'))
        scene['authoring_scope'] = report['scope']
        print('PROPOSAL', json.dumps({key: row[key] for key in ['id', 'rootDeltaPitchDeg', 'rootVerticalTranslationM', 'before', 'after']}), flush=True)

text = bpy.data.texts.new('START HERE - kneeling support proposal')
text.write(report['scope'] + '\nOriginal review scenes and animations are retained unchanged. Author scenes are frozen setup/peak support proposals. Cyan empty controls mark actual skin and joint targets. The JSON records original and proposed engine-coordinate landmarks. Palm changes remain explicit and must be solved through the bounded runtime contact controller.\n')
bpy.ops.wm.save_as_mainfile(filepath=str(output / 'kneeling-support-proposal.blend'))
(output / 'proposal.json').write_text(json.dumps(report, indent=2) + '\n')
