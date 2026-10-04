"""Render matched actual-skin support authoring without overwriting source."""
import bpy
import hashlib
import json
import sys
from pathlib import Path
from mathutils import Vector

folder = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
output = folder / 'renders'; output.mkdir()
report = json.loads((folder / 'authored-prone-thigh-rest.json').read_text())
bpy.ops.wm.open_mainfile(filepath=str(folder / 'authored-prone-thigh-rest.blend'))
rows = []
for case in report['cases']:
    variant = case['variant']
    for label in ['before', 'after']:
        scene = bpy.data.scenes[('Review ' + variant + '-bounded-whole-chain-sparse') if label == 'before' else ('Authored resting hips ' + variant)]
        bpy.context.window.scene = scene
        scene.frame_set(150); bpy.context.view_layer.update()
        bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
        floor = bpy.context.object; floor.name = 'Explicit zero support plane'
        material = bpy.data.materials.new('Floor ' + variant + label); material.diffuse_color = (.26, .30, .33, 1)
        floor.data.materials.append(material)
        scene.render.engine = 'BLENDER_WORKBENCH'; scene.render.image_settings.file_format = 'PNG'
        scene.render.resolution_x = 1000; scene.render.resolution_y = 700; scene.render.resolution_percentage = 100
        scene.display.shading.light = 'STUDIO'; scene.display.shading.color_type = 'MATERIAL'
        scene.display.shading.show_shadows = True; scene.display.shading.show_cavity = True; scene.display.shading.cavity_type = 'BOTH'
        scene.display.shading.background_type = 'WORLD'
        if scene.world is None: scene.world = bpy.data.worlds.new('Review world')
        scene.world.color = (.12, .14, .16)
        rig = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
        points = [rig.matrix_world @ bone.matrix.translation for bone in rig.pose.bones]
        low = Vector(tuple(min(point[i] for point in points) for i in range(3)))
        high = Vector(tuple(max(point[i] for point in points) for i in range(3)))
        center = (low + high) / 2
        for view, offset in [('Side', (1, -.15, .24)), ('Overhead', (0, -.01, 1))]:
            camera = next(obj for obj in scene.objects if obj.type == 'CAMERA' and obj.name.startswith(view + ' camera'))
            camera.location = center + Vector(offset) * 3
            camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
            rotation = camera.rotation_euler.to_quaternion().inverted()
            projected = [rotation @ (point - center) for point in points]
            width = max(point.x for point in projected) - min(point.x for point in projected)
            height = max(point.y for point in projected) - min(point.y for point in projected)
            camera.data.type = 'ORTHO'; camera.data.ortho_scale = max(2.15, width * 1.15, height * 1000 / 700 * 1.15)
            scene.camera = camera
            filename = variant + '-' + label + '-' + view.lower() + '.png'; scene.render.filepath = str(output / filename)
            bpy.ops.render.render(write_still=True)
            rows.append({'variant': variant, 'phase': 'peak', 'timeMs': 2500, 'label': label, 'view': view, 'file': filename})
(output / 'index.json').write_text(json.dumps({'scope': report['scope'], 'sourceProjectSha256': report['projectSha256'], 'renders': rows}, indent=2) + '\n')
