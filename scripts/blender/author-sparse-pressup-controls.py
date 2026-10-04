"""Retain actual source poses with editable contact/bend controls and views.
Supports sparse source probes or dense prepared press-up exports. Selected source
times are measured here; full-trajectory qualification remains a separate check.
Blender --background --python-exit-code 1 --python <script> -- <review-folder>
"""
import bpy
import hashlib
import json
import math
import sys
from pathlib import Path
from mathutils import Vector
import numpy as np

folder = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
output = folder / 'authored-controls'; output.mkdir()
manifest = json.loads((folder / 'manifest.json').read_text())
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
report = {'version': 3, 'blenderVersion': bpy.app.version_string, 'blenderBuildHash': bpy.app.build_hash.decode(),
          'scriptSha256': sha(Path(__file__)), 'sourceProjectSha256': sha(folder / 'full-motion-review.blend'),
          'manifestSha256': sha(folder / 'manifest.json'), 'sourceDigest': manifest['sourceDigest'],
          'scope': 'Selected source phase poses including dense-export ascent/descent, skin/contact clearance and editable review controls. Existing source animation is preserved; full-frame geometry, clinical/native/host acceptance remain separate.',
          'romClamp': manifest.get('romClamp'),
          'contactControlConvention': 'World-zero palm plane anchors plus first realized wrist targets. Optional two-bone IK is saved muted; activating it is a new Blender edit needing revalidation.',
          'floorY': 0, 'cases': []}
bpy.ops.wm.open_mainfile(filepath=str(folder / 'full-motion-review.blend'))
for case in manifest['cases']:
    sample_times = case.get('sourceSampleTimesMs')
    if sample_times is None:
        evidence = json.loads((folder / case['supportEvidence']).read_text())
        authored = evidence['authored']; keys = authored['keyframes']
        if len(keys) != 3 or authored.get('timeScale', 1) != 1 or authored.get('reps', 1) != 1 or authored.get('loop', False):
            raise RuntimeError('Dense control authoring requires the explicit three-phase single press-up clock')
        setup = keys[0]['durationMs'] + keys[0].get('holdMs', 0)
        peak = setup + keys[1]['durationMs']; hold_end = peak + keys[1].get('holdMs', 0)
        total = hold_end + keys[2]['durationMs'] + keys[2].get('holdMs', 0)
        if abs(total - case['durationMs']) > .001:
            raise RuntimeError('Authored and export clocks differ; do not invent phase markers')
        sample_times = [0, setup, peak, hold_end, total]
        phase_times = [('start', 0), ('setup', setup), ('ascent', (setup + peak) / 2),
                       ('peak', peak), ('hold-end', hold_end), ('descent', (hold_end + total) / 2), ('return', total)]
        guide_times = [frame * 1000 / manifest['fps'] for frame in range(case['frames'])]
    else:
        guide_times = sample_times
        phase_times = list(zip(['start', 'setup', 'peak', 'hold-end', 'return'], sample_times))
    scene = bpy.data.scenes['Review ' + case['id']]; bpy.context.window.scene = scene
    rig = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
    controls = bpy.data.collections.new('Editable support and bend guides ' + case['variant']); scene.collection.children.link(controls)
    scene.frame_set(0); bpy.context.view_layer.update()
    for side in ['L', 'R']:
        wrist = rig.matrix_world @ rig.pose.bones['CC_Base_' + side + '_Hand'].matrix.translation
        target = bpy.data.objects.new(side + ' fixed wrist target ' + case['variant'], None); controls.objects.link(target)
        target.location = wrist; target.empty_display_type = 'SPHERE'; target.empty_display_size = .015; target.show_in_front = True
        plane = bpy.data.objects.new(side + ' palm floor anchor ' + case['variant'], None); controls.objects.link(plane)
        plane.location = (wrist.x, wrist.y, 0); plane.empty_display_type = 'CIRCLE'; plane.empty_display_size = .04; plane.show_in_front = True
        pole = bpy.data.objects.new(side + ' elbow guide ' + case['variant'], None); controls.objects.link(pole)
        pole.empty_display_type = 'SPHERE'; pole.empty_display_size = .02; pole.show_in_front = True
        for time_ms in guide_times:
            frame = time_ms * manifest['fps'] / 1000; scene.frame_set(round(frame)); bpy.context.view_layer.update()
            elbow = rig.matrix_world @ rig.pose.bones['CC_Base_' + side + '_Forearm'].matrix.translation
            shoulder = rig.matrix_world @ rig.pose.bones['CC_Base_' + side + '_Upperarm'].matrix.translation
            axis = (wrist - shoulder).normalized(); perpendicular = elbow - (shoulder + axis * (elbow - shoulder).dot(axis))
            if perpendicular.length < .005: perpendicular = Vector((1 if side == 'L' else -1, .1, .1))
            pole.location = elbow + perpendicular.normalized() * .15; pole.keyframe_insert('location', frame=frame)
        constraint = rig.pose.bones['CC_Base_' + side + '_Forearm'].constraints.new('IK')
        constraint.name = 'Optional authoring only - muted source preservation'; constraint.target = target; constraint.pole_target = pole
        constraint.chain_count = 2; constraint.use_rotation = False; constraint.mute = True
    scene.render.engine = 'BLENDER_WORKBENCH'; scene.render.image_settings.file_format = 'PNG'
    scene.render.resolution_x = 1000; scene.render.resolution_y = 700; scene.render.resolution_percentage = 100
    scene.display.shading.light = 'STUDIO'; scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = True; scene.display.shading.show_cavity = True; scene.display.shading.cavity_type = 'BOTH'
    scene.display.shading.background_type = 'WORLD'
    if not scene.world: scene.world = bpy.data.worlds.new('Review world ' + case['variant'])
    scene.world.color = (.12, .14, .16)
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0)); floor = bpy.context.object
    floor.name = 'Explicit zero support plane'; material = bpy.data.materials.new('Floor ' + case['variant']); material.diffuse_color = (.26, .30, .33, 1); floor.data.materials.append(material)
    meshes = []
    for obj in scene.objects:
        if obj.type != 'MESH' or not any(modifier.type == 'ARMATURE' for modifier in obj.modifiers): continue
        groups = {group.index: group.name for group in obj.vertex_groups}
        owners = [groups[max(vertex.groups, key=lambda group: group.weight).group] if vertex.groups else '' for vertex in obj.data.vertices]
        masks = {'all': np.arange(len(owners), dtype=np.int32)}
        for side in ['L', 'R']:
            masks[side + '_palm'] = np.array([i for i, name in enumerate(owners) if name == 'CC_Base_' + side + '_Hand'], dtype=np.int32)
            masks[side + '_wholeHand'] = np.array([i for i, name in enumerate(owners) if '_' + side + '_' in name and any(part in name for part in ['Hand', 'Thumb', 'Index', 'Mid', 'Ring', 'Pinky'])], dtype=np.int32)
        meshes.append((obj, owners, masks))
    samples = []
    for phase, time_ms in phase_times:
        scene.frame_set(round(time_ms * manifest['fps'] / 1000)); bpy.context.view_layer.update()
        minima = {}; graph = bpy.context.evaluated_depsgraph_get()
        for obj, owners, masks in meshes:
            evaluated = obj.evaluated_get(graph); mesh = evaluated.to_mesh()
            coords = np.empty(len(mesh.vertices) * 3); mesh.vertices.foreach_get('co', coords); matrix = np.array(evaluated.matrix_world)
            points = coords.reshape((-1, 3)) @ matrix[:3, :3].T + matrix[:3, 3]
            for name, ids in masks.items():
                if not len(ids): continue
                index = int(ids[np.argmin(points[ids, 2])]); value = float(points[index, 2])
                if name not in minima or value < minima[name]['gapM']:
                    minima[name] = {'gapM': value, 'mesh': obj.name, 'vertex': index, 'dominantBone': owners[index], 'enginePositionM': [float(points[index, 0]), value, float(-points[index, 1])]}
            evaluated.to_mesh_clear()
        points = [rig.matrix_world @ bone.matrix.translation for bone in rig.pose.bones]
        low = Vector(tuple(min(point[i] for point in points) for i in range(3))); high = Vector(tuple(max(point[i] for point in points) for i in range(3))); center = (low + high) / 2
        rendered = []
        for view, offset in [('Side', (1, -.15, .24)), ('Overhead', (0, -.01, 1))]:
            camera = next(obj for obj in scene.objects if obj.type == 'CAMERA' and obj.name.startswith(view + ' camera'))
            camera.location = center + Vector(offset) * 3; camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
            rotation = camera.rotation_euler.to_quaternion().inverted(); projected = [rotation @ (point - center) for point in points]
            width = max(point.x for point in projected) - min(point.x for point in projected); height = max(point.y for point in projected) - min(point.y for point in projected)
            camera.data.type = 'ORTHO'; camera.data.ortho_scale = max(2.15, width * 1.15, height * 1000 / 700 * 1.15); scene.camera = camera
            filename = case['variant'] + '-' + phase + '-' + view.lower() + '.png'; scene.render.filepath = str(output / filename)
            bpy.ops.render.render(write_still=True); rendered.append(filename)
        samples.append({'phase': phase, 'timeMs': time_ms, 'skinMinima': minima, 'renders': rendered})
    report['cases'].append({'variant': case['variant'], 'sourceModelSha256': case['sourceModelSha256'],
                           'romClamp': case.get('romClamp', manifest.get('romClamp')),
                           'sourceProbeSha256': case.get('sourceProbeSha256'), 'supportEvidenceSha256': case.get('supportEvidenceSha256'),
                           'guideSampleCount': len(guide_times), 'samples': samples})
    scene['qualification'] = report['scope']; scene.frame_set(round(sample_times[2] * manifest['fps'] / 1000))
bpy.data.texts.new('SOURCE QUALIFICATION').write(json.dumps(report, indent=2))
bpy.ops.wm.save_as_mainfile(filepath=str(output / 'editable-pressup-proposal.blend'))
report['projectSha256'] = sha(output / 'editable-pressup-proposal.blend')
(output / 'sparse-authoring-review.json').write_text(json.dumps(report, indent=2) + '\n')
