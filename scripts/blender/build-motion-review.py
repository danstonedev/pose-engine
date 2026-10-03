"""Create full-animation Blender review scenes for any export-review manifest.
Blender --background --factory-startup --python build-motion-review.py -- <folder>
"""
import bpy
import json
import sys
from pathlib import Path
from mathutils import Vector
from mathutils.kdtree import KDTree

folder = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8-sig'))
project = folder / 'full-motion-review.blend'
if project.exists() or (folder / 'roundtrip').exists():
    raise RuntimeError('Use a fresh export directory; previous reviews are preserved')
(folder / 'roundtrip').mkdir()
report = {'blenderVersion': bpy.app.version_string, 'sourceDigest': manifest['sourceDigest'],
          'toleranceM': .0001, 'scope': 'Bone and rendered-skin exchange. Movement quality remains a separate review.', 'cases': []}

def engine_point(point):
    return Vector((point.x, point.z, -point.y))

def skin_tree():
    graph = bpy.context.evaluated_depsgraph_get()
    points = []
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        points.extend(engine_point(evaluated.matrix_world @ vertex.co) for vertex in mesh.vertices)
        evaluated.to_mesh_clear()
    tree = KDTree(len(points))
    for index, point in enumerate(points):
        tree.insert(point, index)
    tree.balance()
    return tree

for case in manifest['cases']:
    scene = bpy.data.scenes.new('Review ' + case['id'])
    bpy.context.window.scene = scene
    scene.unit_settings.system, scene.render.fps = 'METRIC', manifest['fps']
    scene.frame_start, scene.frame_end = 0, case['frames'] - 1
    bpy.ops.import_scene.gltf(filepath=str(folder / case['file']), bone_heuristic='BLENDER', guess_original_bind_pose=True)
    rig = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
    for obj in scene.objects:
        for modifier in obj.modifiers:
            if modifier.type == 'ARMATURE':
                modifier.use_deform_preserve_volume = False
    data = json.loads((folder / case['expected']).read_text(encoding='utf-8-sig'))
    measurements = []
    for expected in data['expected']:
        scene.frame_set(expected['frame'] - 1)
        bpy.context.view_layer.update()
        bone_error = max((engine_point(rig.matrix_world @ rig.pose.bones[name].matrix.translation) - Vector(point)).length
                         for name, point in expected['bones'].items())
        tree = skin_tree()
        skin_error = max(tree.find(Vector(point))[2] for point in expected['skinPointsM'])
        measurements.append({'timeSec': expected['timeSec'], 'maxBoneErrorM': bone_error, 'maxSkinErrorM': skin_error})
    result = {'id': case['id'], 'checkpoints': measurements,
              'passed': all(max(row['maxBoneErrorM'], row['maxSkinErrorM']) <= report['toleranceM'] for row in measurements)}
    report['cases'].append(result)
    scene.frame_set(0)
    bpy.ops.export_scene.gltf(filepath=str(folder / 'roundtrip' / case['file']), export_format='GLB',
        # Imported source tracks already contain all sampled helper deformation.
        # Keep their fractional terminal key (e.g. 1.695 s), which integer-frame
        # scene baking would shift and interpolate to a different final pose.
        use_active_scene=True, export_animations=True, export_animation_mode='ACTIVE_ACTIONS', export_force_sampling=False,
        export_frame_range=True, export_frame_step=1, export_optimize_animation_size=False,
        export_rest_position_armature=True, export_yup=True, export_skins=True,
        export_all_influences=True, export_cameras=False, export_lights=False)
    for label, frame in [('Setup', case.get('setupFrame', 0)), ('Middle review', case['holdFrame'] - 1), ('Return', scene.frame_end)]:
        scene.timeline_markers.new(label, frame=frame)
    # Multiple saved views include the entire moving body, including head/neck.
    scene.frame_set(case['holdFrame'] - 1)
    bpy.context.view_layer.update()
    positions = [rig.matrix_world @ bone.matrix.translation for bone in rig.pose.bones]
    center = sum(positions, Vector()) / len(positions)
    span = max(1.8, max((point - center).length for point in positions) * 2.5)
    for label, offset in [('Side', (1, -.15, .3)), ('Front', (0, -1, .3)), ('Back', (0, 1, .3)), ('Overhead', (0, -.01, 1))]:
        camera = bpy.data.objects.new(label + ' camera', bpy.data.cameras.new(label))
        scene.collection.objects.link(camera)
        camera.location = center + Vector(offset) * span
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera.data.type, camera.data.ortho_scale = 'ORTHO', span
        if label == 'Side':
            scene.camera = camera
    rig.show_in_front = False
    scene['review_status'] = 'Exchange measured; full-cycle visual, contact, clinical and native acceptance must be recorded separately.'
    print('EXCHANGE', json.dumps(result), flush=True)

readme = bpy.data.texts.new('START HERE - full movement review')
readme.write('Use the scene selector for each body/movement. Space plays the complete animation. Timeline markers label setup, middle and return. Select one of the four saved cameras, then Ctrl+Numpad 0. Inspect contacts, bend directions, transitions, head/neck and body clearance. Numerical exchange agreement does not approve movement quality. Author changes in a separate scene and retain these references.\n')
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_perspective = 'CAMERA'
            area.spaces.active.shading.type = 'SOLID'
bpy.ops.wm.save_as_mainfile(filepath=str(project))
(folder / 'full-motion-exchange.json').write_text(json.dumps(report, indent=2) + '\n')
if not all(case['passed'] for case in report['cases']):
    raise RuntimeError('Blender import differs from measured source; inspect preserved evidence')
print('FULL_MOTION_REVIEW_READY', str(project), flush=True)
