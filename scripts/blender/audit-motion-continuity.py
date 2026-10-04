"""Measure every exported source frame and the return-to-start seam in Blender.
Records witnesses rather than inventing a new movement acceptance threshold.
"""
import bpy
import hashlib
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

folder = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
output = folder / 'continuity-review'; output.mkdir()
manifest = json.loads((folder / 'manifest.json').read_text())
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
report = {'version': 1, 'blenderVersion': bpy.app.version_string, 'scriptSha256': sha(Path(__file__)),
          'projectSha256': sha(folder / 'full-motion-review.blend'), 'sourceDigest': manifest['sourceDigest'],
          'scope': 'Every exported bone frame and return/start seam. Adjacent transform maxima are observations, not new clinical/velocity gates. Actual host loop handling remains separate.', 'cases': []}
bpy.ops.wm.open_mainfile(filepath=str(folder / 'full-motion-review.blend'))
for case in manifest['cases']:
    scene = bpy.data.scenes['Review ' + case['id']]; bpy.context.window.scene = scene
    rig = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
    first = None; previous = None
    worst_step = {'radians': 0}; worst_position_step = {'distanceM': 0}
    wrist_drift = {'L': 0, 'R': 0}
    for frame in range(case['frames']):
        scene.frame_set(frame); bpy.context.view_layer.update()
        state = {bone.name: {'position': (rig.matrix_world @ bone.matrix).translation.copy(), 'rotation': bone.matrix_basis.to_quaternion()} for bone in rig.pose.bones}
        if first is None: first = state
        if previous:
            for name, value in state.items():
                angle = previous[name]['rotation'].rotation_difference(value['rotation']).angle
                angle = min(angle, 2 * math.pi - angle)
                distance = (previous[name]['position'] - value['position']).length
                if angle > worst_step['radians']: worst_step = {'bone': name, 'fromMs': (frame - 1) * 1000 / manifest['fps'], 'toMs': frame * 1000 / manifest['fps'], 'radians': angle, 'degrees': math.degrees(angle)}
                if distance > worst_position_step['distanceM']: worst_position_step = {'bone': name, 'fromMs': (frame - 1) * 1000 / manifest['fps'], 'toMs': frame * 1000 / manifest['fps'], 'distanceM': distance}
        for side in ['L', 'R']:
            key = 'CC_Base_' + side + '_Hand'; wrist_drift[side] = max(wrist_drift[side], (state[key]['position'] - first[key]['position']).length)
        previous = state
    seam = []
    for name, value in previous.items():
        angle = first[name]['rotation'].rotation_difference(value['rotation']).angle; angle = min(angle, 2 * math.pi - angle)
        seam.append({'bone': name, 'distanceM': (value['position'] - first[name]['position']).length, 'localAngleDeg': math.degrees(angle)})
    row = {'variant': case['variant'], 'frames': case['frames'], 'boneCount': len(first), 'wristDriftM': wrist_drift,
           'maximumAdjacentBoneRotation': worst_step, 'maximumAdjacentBoneTranslation': worst_position_step,
           'seamWorstPosition': max(seam, key=lambda value: value['distanceM']), 'seamWorstLocalRotation': max(seam, key=lambda value: value['localAngleDeg']), 'seamAllBones': seam}
    report['cases'].append(row)
    print(case['variant'], json.dumps({key: value for key, value in row.items() if key != 'seamAllBones'}), flush=True)
    # The generic renderer already includes ascent, setup, hold and return;
    # add actual descent and the witnessed fastest bone-rotation checkpoint.
    scene.render.engine = 'BLENDER_WORKBENCH'; scene.render.image_settings.file_format = 'PNG'
    scene.render.resolution_x = 1000; scene.render.resolution_y = 700; scene.render.resolution_percentage = 100
    scene.display.shading.light = 'STUDIO'; scene.display.shading.color_type = 'MATERIAL'; scene.display.shading.show_shadows = True; scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = 'BOTH'; scene.display.shading.background_type = 'WORLD'
    if not scene.world: scene.world = bpy.data.worlds.new('Review world')
    scene.world.color = (.12, .14, .16)
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, case['floorY'])); floor = bpy.context.object
    material = bpy.data.materials.new('Floor ' + case['variant']); material.diffuse_color = (.26, .30, .33, 1); floor.data.materials.append(material)
    for phase, time_ms in [('descent', 4750), ('fastest-bone-before', worst_step['fromMs']), ('fastest-bone-after', worst_step['toMs'])]:
        scene.frame_set(round(time_ms * manifest['fps'] / 1000)); bpy.context.view_layer.update()
        points = [rig.matrix_world @ bone.matrix.translation for bone in rig.pose.bones]
        low = Vector(tuple(min(point[i] for point in points) for i in range(3))); high = Vector(tuple(max(point[i] for point in points) for i in range(3))); center = (low + high) / 2
        for view, offset in [('Side', (1, -.15, .24)), ('Overhead', (0, -.01, 1))]:
            camera = next(obj for obj in scene.objects if obj.type == 'CAMERA' and obj.name.startswith(view + ' camera'))
            camera.location = center + Vector(offset) * 3; camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
            rotation = camera.rotation_euler.to_quaternion().inverted(); projected = [rotation @ (point - center) for point in points]
            width = max(point.x for point in projected) - min(point.x for point in projected); height = max(point.y for point in projected) - min(point.y for point in projected)
            camera.data.ortho_scale = max(2.15, width * 1.15, height * 1000 / 700 * 1.15); scene.camera = camera
            scene.render.filepath = str(output / (case['variant'] + '-' + phase + '-' + view.lower() + '.png')); bpy.ops.render.render(write_still=True)
(output / 'continuity.json').write_text(json.dumps(report, indent=2) + '\n')
