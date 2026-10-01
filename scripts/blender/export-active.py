"""Run from the project's Text Editor, or Blender --background project.blend
--python-exit-code 1 --python export-active.py. Writes a fresh candidate folder.
"""
import bpy
import datetime
import hashlib
import json
from pathlib import Path

scene = bpy.context.scene
if not scene.get('review_authoring'):
    raise RuntimeError('Select an Author scene before exporting a candidate')
source = Path(scene['review_manifest'])
manifest = json.loads(source.read_text())
folder = source.parent / ('candidate-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f'))
folder.mkdir(exist_ok=False)
(folder / 'roundtrip').mkdir()
rig = bpy.data.objects[scene['review_rig']]
meshes = [obj for obj in scene.objects if obj.type == 'MESH' and any(mod.type == 'ARMATURE' and mod.object == rig for mod in obj.modifiers)]
assets = set(meshes + [rig])
for obj in list(assets):
    parent = obj.parent
    while parent:
        assets.add(parent)
        parent = parent.parent
saved_frame = scene.frame_current
saved_selection = list(bpy.context.selected_objects)
saved_active = bpy.context.view_layer.objects.active
saved_hidden = {obj: obj.hide_get() for obj in assets}
expected = []
try:
    for frame in sorted({scene.frame_start, saved_frame, scene.frame_end}):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        graph = bpy.context.evaluated_depsgraph_get()
        points = []
        for obj in meshes:
            evaluated = obj.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            for index in range(0, len(mesh.vertices), max(1, len(mesh.vertices) // 256)):
                p = evaluated.matrix_world @ mesh.vertices[index].co
                points.append([p.x, p.z, -p.y])
            evaluated.to_mesh_clear()
        bone_points = {}
        for bone in rig.pose.bones:
            p = rig.matrix_world @ bone.matrix.translation
            bone_points[bone.name] = [p.x, p.z, -p.y]
        expected.append({'timeSec': (frame - scene.frame_start) / scene.render.fps,
                         'bones': bone_points, 'skinPointsM': points})
    scene.frame_set(saved_frame)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in assets:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(filepath=str(folder / 'roundtrip' / 'candidate.glb'), export_format='GLB',
                              use_selection=True, use_active_scene=True, export_animations=True,
                              export_animation_mode='SCENE', export_force_sampling=True,
                              export_frame_range=True, export_frame_step=1, export_anim_slide_to_zero=True,
                              export_optimize_animation_size=False, export_rest_position_armature=True,
                              export_all_influences=True, export_cameras=False, export_lights=False)
finally:
    scene.frame_set(saved_frame)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in saved_selection:
        obj.select_set(True)
    for obj, hidden in saved_hidden.items():
        obj.hide_set(hidden)
    bpy.context.view_layer.objects.active = saved_active
(folder / 'candidate.expected.json').write_text(json.dumps({'expected': expected}))
candidate = {'sourceRevision': manifest['sourceRevision'], 'expectedSource': 'Blender authored scene',
             'blenderVersion': bpy.app.version_string, 'sourceCase': scene['review_case'],
             'sourceModelSha256': next(c['sourceModelSha256'] for c in manifest['cases'] if c['id'] == scene['review_case']),
             'project': bpy.data.filepath, 'clinicalLimitsValidated': False,
             'note': 'Baked visible authoring controls. Engine replay checks export fidelity only; joint limits, contact, anatomy and motion quality still require review.',
             'cases': [{'id': scene['review_case'], 'file': 'candidate.glb', 'expected': 'candidate.expected.json'}]}
(folder / 'manifest.json').write_text(json.dumps(candidate, indent=2) + '\n')
print('CANDIDATE_READY', str(folder), flush=True)
