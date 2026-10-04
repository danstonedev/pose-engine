"""Render authored proposal checkpoints without modifying its saved project."""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

folder = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
output = folder / 'renders'
output.mkdir()
probe = (folder / 'prone-knee-toe-probe.json').exists()
stem = 'prone-knee-toe-probe' if probe else 'whole-chain-authoring'
report = json.loads((folder / (stem + '.json')).read_text())
bpy.ops.wm.open_mainfile(filepath=str(folder / (stem + '.blend')))
for case in report['cases']:
    scene = bpy.data.scenes['Probe ' + case['variant'] + ' ' + case['phase'] if probe else 'Author whole chain ' + case['variant']]
    bpy.context.window.scene = scene
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
    floor = bpy.context.object
    floor.name = 'Explicit world-zero review floor'
    material = bpy.data.materials.new('Floor ' + case['variant']); material.diffuse_color = (.26, .30, .33, 1)
    floor.data.materials.append(material)
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 1000, 700, 100
    scene.render.image_settings.file_format = 'PNG'
    scene.display.shading.light = 'STUDIO'; scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = True; scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = 'BOTH'; scene.display.shading.background_type = 'WORLD'
    if not scene.world: scene.world = bpy.data.worlds.new('Review world')
    scene.world.color = (.12, .14, .16)
    rig = next(o for o in scene.objects if o.type == 'ARMATURE')
    phases = [(case['phase'], case['sourceTimeSec'])] if probe else [('setup', 1), ('extension', 2.1), ('hold', 3.2), ('return', 5.4)]
    for phase, seconds in phases:
        scene.frame_set(round(seconds * case.get('sampleHz', 60))); bpy.context.view_layer.update()
        points = [rig.matrix_world @ b.matrix.translation for b in rig.pose.bones]
        low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
        high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
        center = (low + high) / 2
        for view, offset in [('Side', (1, -.15, .25)), ('Overhead', (0, -.01, 1))]:
            camera = next(o for o in scene.objects if o.type == 'CAMERA' and o.name.startswith(view + ' camera'))
            camera.location = center + Vector(offset) * 3
            camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
            rotation = camera.rotation_euler.to_quaternion().inverted()
            projected = [rotation @ (p - center) for p in points]
            width = max(p.x for p in projected) - min(p.x for p in projected)
            height = max(p.y for p in projected) - min(p.y for p in projected)
            camera.data.type = 'ORTHO'; camera.data.ortho_scale = max(2.15, width * 1.15, height * 1000 / 700 * 1.15)
            scene.camera = camera
            scene.render.filepath = str(output / f"{case['variant']}-{phase}-{view.lower()}.png")
            bpy.ops.render.render(write_still=True)
