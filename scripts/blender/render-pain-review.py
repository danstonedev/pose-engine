"""Render the full pain-response cycle and close facial comparisons from production-rig clips.
Blender --background --python render-pain-review.py -- <review-folder> <fresh-render-folder>
These views inspect authored expression; furniture/contact and native force are separate.
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector, Matrix

args = sys.argv[sys.argv.index('--') + 1:]
folder = Path(args[0]).resolve()
output = folder / (args[1] if len(args) > 1 else 'pain-renders')
output.mkdir()
manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8-sig'))
bpy.ops.wm.open_mainfile(filepath=str(folder / 'full-motion-review.blend'))
renders = []

def aim(camera, target, eye, up):
    forward = (target - eye).normalized()
    right = forward.cross(up).normalized()
    vertical = right.cross(forward).normalized()
    camera.matrix_world = Matrix(((right.x, vertical.x, -forward.x, eye.x),
                                  (right.y, vertical.y, -forward.y, eye.y),
                                  (right.z, vertical.z, -forward.z, eye.z),
                                  (0, 0, 0, 1)))

for case in manifest['cases']:
    scene = bpy.data.scenes['Review ' + case['id']]
    bpy.context.window.scene = scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 640, 480, 100
    scene.render.image_settings.file_format = 'PNG'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = 'BOTH'
    scene.display.shading.background_type = 'WORLD'
    if scene.world is None:
        scene.world = bpy.data.worlds.new(case['id'] + ' review world')
    scene.world.color = (.12, .14, .16)
    rig = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
    head = next(bone for bone in rig.pose.bones if bone.name.endswith('_Head'))
    hips = next(bone for bone in rig.pose.bones if bone.name.endswith('_Hip') or bone.name.endswith('_Pelvis'))
    camera = next(obj for obj in scene.objects if obj.type == 'CAMERA')
    scene.camera = camera
    window = case['window']
    phases = [('setup', 0), ('onset', window['onsetMs']), ('peak', window['onsetMs'] + 300),
              ('sustained', window['onsetMs'] + 1000), ('recovery', window['releaseMs'] + 350), ('return', case['durationMs'])]
    for phase, ms in phases:
        frame = ms / 1000 * manifest['fps']
        scene.frame_set(math.floor(frame), subframe=frame - math.floor(frame))
        bpy.context.view_layer.update()
        points = [rig.matrix_world @ bone.matrix.translation for bone in rig.pose.bones]
        low = Vector(tuple(min(point[i] for point in points) for i in range(3)))
        high = Vector(tuple(max(point[i] for point in points) for i in range(3)))
        center = (low + high) / 2
        up = (rig.matrix_world @ head.matrix.translation - rig.matrix_world @ hips.matrix.translation).normalized()
        # Oblique whole-body view includes the head, axial chain, both hands and tested leg.
        aim(camera, center, center + Vector((1.5, -1.7, 2.2)), up)
        rotation = camera.matrix_world.to_quaternion().inverted()
        projected = [rotation @ (point - center) for point in points]
        width = max(point.x for point in projected) - min(point.x for point in projected)
        height = max(point.y for point in projected) - min(point.y for point in projected)
        # Bone origins do not include the full toe/skin envelope.
        camera.data.type, camera.data.ortho_scale = 'ORTHO', max(width * 1.35, height * 4/3 * 1.35)
        views = [('body', center, camera.location.copy(), camera.data.ortho_scale)]
        if phase in ['setup', 'peak', 'sustained'] and case['variant'] != 'neutral':
            face = rig.matrix_world @ head.matrix.translation + up * .08
            # Approach from above the head so the flexed tested leg cannot cover the mouth.
            views.append(('face', face, face + Vector((0, 0, .6)) + up * .08, .38))
        for view, target, eye, scale in views:
            aim(camera, target, eye, up)
            camera.data.ortho_scale = scale
            filename = f"{case['id']}-{phase}-{view}.png"
            scene.render.filepath = str(output / filename)
            bpy.ops.render.render(write_still=True)
            renders.append({'id': case['id'], 'pattern': case['pattern'], 'body': case['variant'], 'side': case['side'], 'phase': phase, 'timeMs': ms, 'view': view, 'file': filename})
    scene['pain_pattern'] = case['pattern']
    scene['pain_review_scope'] = 'Editable full-cycle authored expression. Browser contact and native dynamics require separate evidence.'
    print('PAIN_RENDERED', case['id'], flush=True)
(output / 'index.json').write_text(json.dumps({'sourceDigest': manifest['sourceDigest'], 'blenderVersion': bpy.app.version_string, 'renders': renders}, indent=2) + '\n')
# Keep camera framing edits separate from the measured exchange project.
bpy.ops.wm.save_as_mainfile(filepath=str(output / 'pain-visual-review.blend'))
