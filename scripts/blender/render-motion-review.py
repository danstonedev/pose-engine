"""Render setup, approach, supported motion and return from a saved review.
Blender --background --python render-motion-review.py -- <review-folder>
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
folder = Path(args[0]).resolve()
manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8-sig'))
output = folder / (args[1] if len(args) > 1 else 'renders')
output.mkdir()
bpy.ops.wm.open_mainfile(filepath=str(folder / 'full-motion-review.blend'))
renders = []
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
    if 'floorY' not in case:
        raise RuntimeError('Re-export with the measured engine floor before reviewing contact clearance')
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, case['floorY']))
    floor = bpy.context.object
    floor.name = 'Review support plane'
    material = bpy.data.materials.new(case['id'] + ' floor')
    material.diffuse_color = (.26, .30, .33, 1)
    floor.data.materials.append(material)
    setup = case['setupFrame'] / manifest['fps']
    end = case['durationMs'] / 1000
    phases = [('start', 0), ('approach', setup / 2), ('setup', setup),
              ('quarter', setup + (end - setup) / 4), ('middle', setup + (end - setup) / 2), ('return', end)]
    for phase, seconds in phases:
        frame = seconds * manifest['fps']
        scene.frame_set(math.floor(frame), subframe=frame - math.floor(frame))
        bpy.context.view_layer.update()
        rig = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
        points = [rig.matrix_world @ bone.matrix.translation for bone in rig.pose.bones]
        low = Vector(tuple(min(point[i] for point in points) for i in range(3)))
        high = Vector(tuple(max(point[i] for point in points) for i in range(3)))
        center = (low + high) / 2
        for view, offset in [('Side', (1, -.15, .3)), ('Overhead', (0, -.01, 1))]:
            if view == 'Overhead' and phase not in ['setup', 'middle', 'return']:
                continue
            camera = next(obj for obj in scene.objects if obj.type == 'CAMERA' and obj.name.startswith(view + ' camera'))
            camera.location = center + Vector(offset) * 3
            camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
            rotation = camera.rotation_euler.to_quaternion().inverted()
            projected = [rotation @ (point - center) for point in points]
            width = max(point.x for point in projected) - min(point.x for point in projected)
            height = max(point.y for point in projected) - min(point.y for point in projected)
            camera.data.ortho_scale = max(1.8, width * 1.2, height * 4 / 3 * 1.2)
            scene.camera = camera
            filename = f"{case['id']}-{phase}-{view.lower()}.png"
            scene.render.filepath = str(output / filename)
            bpy.ops.render.render(write_still=True)
            renders.append({'id': case['id'], 'phase': phase, 'seconds': seconds, 'view': view, 'file': filename})
(output / 'index.json').write_text(json.dumps({'sourceDigest': manifest['sourceDigest'], 'renders': renders}, indent=2) + '\n')
