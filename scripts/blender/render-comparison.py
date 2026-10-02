"""Render matching close-ups: Blender -b --python render-comparison.py --
<before.blend> <after.blend> <fresh-output-directory>. Source projects are not saved.
"""
import bpy
import json
import sys
from pathlib import Path
from mathutils import Vector

before, after, destination = sys.argv[sys.argv.index('--') + 1:]
folder = Path(destination).resolve()
folder.mkdir(exist_ok=False)
for label, project in [('before', before), ('after', after)]:
    bpy.ops.wm.open_mainfile(filepath=str(Path(project).resolve()))
    for variant, side in [(v, s) for v in ['male', 'female', 'neutral'] for s in ['L', 'R']]:
        scene = bpy.data.scenes['Reference ' + variant + '-' + side]
        bpy.context.window.scene = scene
        scene.frame_set(123)
        bpy.context.view_layer.update()
        rig = scene.objects[scene['review_rig']]
        spine = rig.matrix_world @ rig.pose.bones['CC_Base_Spine02'].matrix.translation
        center = Vector((0, 0, spine.z - 0.08))
        scene.camera.location = center + Vector((2.4 if side == 'L' else -2.4, 4.0, 0.75))
        scene.camera.rotation_euler = (center-scene.camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.camera.data.ortho_scale = 1.15 * spine.z / 1.37
        scene.render.filepath = str(folder / f'{variant}-{side}-{label}.png')
        bpy.ops.render.render(write_still=True)
(folder / 'sources.json').write_text(json.dumps({'before': str(Path(before).resolve()),
    'after': str(Path(after).resolve()), 'frame': 123, 'blenderVersion': bpy.app.version_string}, indent=2))
print('COMPARISON_READY', folder)
