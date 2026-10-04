"""Measure evaluated hand skin and author editable surface targets on world zero.

Blender --background --factory-startup --python-exit-code 1 --python
  scripts/blender/author-palm-surface-support.py -- <review-folder> <fresh-output>

Uses existing full animations, including exported production twist. Controls are
target proposals: they do not silently move the rig, translate the body or claim
that a clinically bounded arm solver has reached them.
"""
import bpy
import hashlib
import json
import math
from pathlib import Path
import sys
from mathutils import Vector
import numpy as np

args = sys.argv[sys.argv.index('--') + 1:]
source, output = map(lambda value: Path(value).resolve(), args[:2])
output.mkdir()
manifest_path = source / 'manifest.json'
project_path = source / 'full-motion-review.blend'
manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))

def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def ep(point):
    return [float(point[0]), float(point[2]), float(-point[1])]

report = {'schemaVersion': 1, 'blenderVersion': bpy.app.version_string,
          'blenderBuildHash': bpy.app.build_hash.decode(), 'sourceDigest': manifest['sourceDigest'],
          'sourceRevision': manifest.get('sourceRevision'), 'sourceStatus': manifest.get('sourceStatus'),
          'sourceManifestSha256': sha256(manifest_path), 'sourceProjectSha256': sha256(project_path),
          'scriptSha256': sha256(Path(__file__)), 'floorY': 0, 'fps': manifest['fps'],
          'scope': 'Authored skin geometry and editable target controls. Original animation remains unchanged. No force, tissue compression, IK reachability, clinical or delivered-host acceptance.',
          'criteriaBeforeMeasurement': ['Measure every exported extension-clearing sample on male/female/neutral and both hands.',
              'Select skin by hand-bone descendants, comparing summed influence >=0.5 with dominant influence membership.',
              'Preserve source project and motions, and put each proposed skin contact exactly on the explicit world-zero plane.',
              'Report full-cycle support-depth variation before assuming that a constant offset is reusable.'],
          'membership': 'Hand bone and all recursive descendants. Primary membership: sum of their vertex weights >=0.5. Independently compare dominant-bone membership. No string-based finger classification.',
          'phaseMetadata': 'Unknown: existing setupFrame and holdFrame are review markers, not authoritative phases.',
          'cases': [], 'renders': []}
bpy.ops.wm.open_mainfile(filepath=str(project_path))

def material(name, color):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1)
    return value

red = material('Existing wrist and penetrating skin', (.9, .15, .07))
green = material('Proposed supported wrist and surface', (.1, .8, .3))
blue = material('World-zero support plane', (.25, .37, .45))

def ball(name, point, mat, radius=.005):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=radius, location=point)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    obj.show_in_front = True
    return obj

def line(name, a, b, mat, width=.0015):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions, curve.bevel_depth, curve.bevel_resolution = '3D', width, 1
    path = curve.splines.new('POLY')
    path.points.add(1)
    path.points[0].co, path.points[1].co = (*a, 1), (*b, 1)
    obj = bpy.data.objects.new(name, curve)
    obj.show_in_front = True
    bpy.context.scene.collection.objects.link(obj)
    curve.materials.append(mat)
    return obj

for case in manifest['cases']:
    if case['movement'] != 'extension-clearing':
        continue
    if sha256(source / case['file']) != case['glbSha256']:
        raise RuntimeError('Source animation hash changed: ' + case['id'])
    scene = bpy.data.scenes['Review ' + case['id']]
    bpy.context.window.scene = scene
    rig = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
    hand_info = {}
    meshes = []
    for side in ['L', 'R']:
        hand = rig.data.bones['CC_Base_' + side + '_Hand']
        hand_info[side] = {'bone': hand.name, 'descendants': {hand.name, *(child.name for child in hand.children_recursive)}}
    for obj in scene.objects:
        if obj.type != 'MESH' or not any(mod.type == 'ARMATURE' and mod.object == rig for mod in obj.modifiers):
            continue
        groups = {group.index: group.name for group in obj.vertex_groups}
        selections = {}
        for side, info in hand_info.items():
            summed, dominant, palm_weighted, palm_dominant = [], [], [], []
            for vertex in obj.data.vertices:
                if not vertex.groups:
                    continue
                if sum(item.weight for item in vertex.groups if groups[item.group] in info['descendants']) >= .5:
                    summed.append(vertex.index)
                if groups[max(vertex.groups, key=lambda item: item.weight).group] in info['descendants']:
                    dominant.append(vertex.index)
                if sum(item.weight for item in vertex.groups if groups[item.group] == info['bone']) >= .5:
                    palm_weighted.append(vertex.index)
                if groups[max(vertex.groups, key=lambda item: item.weight).group] == info['bone']:
                    palm_dominant.append(vertex.index)
            selections[side] = {mode: np.array(indices, dtype=np.int32) for mode, indices in
                                [('summed', summed), ('dominant', dominant), ('palmWeighted', palm_weighted), ('palmDominant', palm_dominant)]}
        if any(len(selection['summed']) for selection in selections.values()):
            meshes.append((obj, groups, selections))
    if not meshes:
        raise RuntimeError('No hand skin found: ' + case['id'])
    row = {'id': case['id'], 'variant': case['variant'], 'sourceModelSha256': case['sourceModelSha256'],
           'glbSha256': case['glbSha256'], 'durationMs': case['durationMs'], 'frames': case['frames'],
           'engineReferenceY': case['floorY'], 'hands': {}}
    for side, info in hand_info.items():
        row['hands'][side] = {'bone': info['bone'], 'descendantBones': sorted(info['descendants']),
            'counts': {mode: sum(len(selections[side][mode]) for _, _, selections in meshes) for mode in ['summed', 'dominant', 'palmWeighted', 'palmDominant']},
            'samples': []}
    author_index = min(case['frames'] - 1, case['holdFrame'] - 1)
    for sample in range(case['frames']):
        seconds = min(sample / manifest['fps'], case['durationMs'] / 1000)
        frame = seconds * manifest['fps']
        scene.frame_set(math.floor(frame), subframe=frame - math.floor(frame))
        graph = bpy.context.evaluated_depsgraph_get()
        evaluated_rig = rig.evaluated_get(graph)
        vertices = []
        for obj, groups, selections in meshes:
            evaluated = obj.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            if len(mesh.vertices) != len(obj.data.vertices):
                raise RuntimeError('Evaluated skin topology changed')
            coords = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
            mesh.vertices.foreach_get('co', coords)
            matrix = np.array(evaluated.matrix_world)
            positions = coords.reshape((-1, 3)) @ matrix[:3, :3].T + matrix[:3, 3]
            vertices.append((obj, groups, selections, positions))
            evaluated.to_mesh_clear()
        for side, info in hand_info.items():
            def point(part):
                return (evaluated_rig.matrix_world @ evaluated_rig.pose.bones['CC_Base_' + side + '_' + part].matrix).translation
            wrist = point('Hand')
            forward = (point('Mid1') - wrist).normalized()
            normal = forward.cross(point('Index1') - point('Pinky1')).normalized() * (1 if side == 'L' else -1)
            lateral = forward.cross(normal).normalized()
            minima, depths_by_membership, depth = {}, {}, -math.inf
            for obj, groups, selections, positions in vertices:
                for mode, indices in selections[side].items():
                    if not len(indices):
                        continue
                    index = int(indices[np.argmin(positions[indices, 2])])
                    if mode not in minima or positions[index, 2] < minima[mode]['clearanceM']:
                        vertex = obj.data.vertices[index]
                        dominant = groups[max(vertex.groups, key=lambda item: item.weight).group]
                        minima[mode] = {'clearanceM': float(positions[index, 2]), 'mesh': obj.name, 'vertexIndex': index,
                                        'dominantBone': dominant, 'enginePositionM': ep(positions[index])}
                    mode_depth = float(((positions[indices] - np.array(wrist)) @ np.array(normal)).max())
                    depths_by_membership[mode] = max(depths_by_membership.get(mode, -math.inf), mode_depth)
                indices = selections[side]['summed']
                if len(indices):
                    distances = (positions[indices] - np.array(wrist)) @ np.array(normal)
                    index = int(indices[np.argmax(distances)])
                    if float(distances.max()) > depth:
                        depth = float(distances.max())
                        relative = Vector(positions[index]) - wrist
                        support_witness = {'mesh': obj.name, 'vertexIndex': index,
                            'enginePositionM': ep(positions[index]),
                            'anatomicalPalmOffsetM': {'forward': relative.dot(forward), 'lateral': relative.dot(lateral), 'palmar': relative.dot(normal)}}
            if not all(mode in minima for mode in ['summed', 'dominant']) or not math.isfinite(depth):
                raise RuntimeError('Hand membership has no finite surface')
            sample_row = {'sampleIndex': sample, 'timeSec': seconds, 'wristEngineM': ep(wrist),
                'palmNormalEngine': ep(normal), 'palmForwardEngine': ep(forward), 'skinMinima': minima,
                'supportDepthAlongPalmNormalM': depth, 'supportWitness': support_witness,
                'supportDepthByMembershipM': depths_by_membership,
                'palmGapIfFullHandPlacedM': minima['palmDominant']['clearanceM'] - minima['summed']['clearanceM'],
                'wristHeightForCurrentOrientationOnWorldZeroM': float(wrist.z) - minima['summed']['clearanceM'],
                'requiredWristTranslationM': [0, -minima['summed']['clearanceM'], 0]}
            row['hands'][side]['samples'].append(sample_row)
            if sample == author_index:
                row['hands'][side]['authoringSample'] = sample_row
    for side, hand in row['hands'].items():
        samples = hand['samples']
        depths = [value['supportDepthAlongPalmNormalM'] for value in samples]
        heights = [value['wristHeightForCurrentOrientationOnWorldZeroM'] for value in samples]
        hand['summary'] = {'minimumSkinClearanceM': min(value['skinMinima']['summed']['clearanceM'] for value in samples),
            'supportDepthMinM': min(depths), 'supportDepthMaxM': max(depths), 'supportDepthRangeM': max(depths) - min(depths),
            'requiredWristHeightMinM': min(heights), 'requiredWristHeightMaxM': max(heights),
            'palmDominantSupportDepthMinM': min(value['supportDepthByMembershipM']['palmDominant'] for value in samples),
            'palmDominantSupportDepthMaxM': max(value['supportDepthByMembershipM']['palmDominant'] for value in samples),
            'palmGapIfFullHandPlacedMaxM': max(value['palmGapIfFullHandPlacedM'] for value in samples),
            'palmGapIfFullHandPlacedMinM': min(value['palmGapIfFullHandPlacedM'] for value in samples),
            'maxMembershipClearanceDifferenceM': max(abs(value['skinMinima']['summed']['clearanceM'] - value['skinMinima']['dominant']['clearanceM']) for value in samples)}
    # Editable controls mark a measured sample. The original motion is retained
    # as reference, without an unconstrained imported-rig IK mutation.
    scene.frame_set(author_index)
    bpy.context.view_layer.update()
    for obj in scene.objects:
        if obj.type == 'MESH' and not any(mod.type == 'ARMATURE' for mod in obj.modifiers):
            obj.hide_render = True
    bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, 0))
    plane = bpy.context.object
    plane.name = 'Explicit world-zero contact reference'
    plane.data.materials.append(blue)
    controls = []
    for side, hand in row['hands'].items():
        selected = hand['authoringSample']
        def bp(value):
            return Vector((value[0], -value[2], value[1]))
        wrist, skin = bp(selected['wristEngineM']), bp(selected['skinMinima']['summed']['enginePositionM'])
        delta = Vector((0, 0, -skin.z))
        surface = skin + delta
        target = wrist + delta
        control = bpy.data.objects.new(side + ' editable palm surface anchor', None)
        control.empty_display_type, control.empty_display_size = 'ARROWS', .025
        control.location = surface
        control['floorY'] = 0.0
        control['scope'] = 'Target only; original animation unchanged. Move with G; runtime solver must validate reach and skin.'
        scene.collection.objects.link(control)
        wrist_control = bpy.data.objects.new(side + ' derived wrist target', None)
        wrist_control.empty_display_type, wrist_control.empty_display_size = 'SPHERE', .012
        scene.collection.objects.link(wrist_control)
        wrist_control.parent = control
        wrist_control.location = target - surface
        wrist_control['supportDepthAlongPalmNormalM'] = selected['supportDepthAlongPalmNormalM']
        wrist_control['anatomicalPalmOffset'] = json.dumps(selected['supportWitness']['anatomicalPalmOffsetM'])
        baseline = [ball(side + ' existing wrist', wrist, red), ball(side + ' existing surface', skin, red, .003), line(side + ' existing wrist to surface', wrist, skin, red)]
        proposed = [ball(side + ' target wrist marker', target, green), ball(side + ' target surface marker', surface, green, .003), line(side + ' surface target offset', target, surface, green)]
        for obj in proposed:
            world = obj.matrix_world.copy()
            obj.parent = control
            obj.matrix_world = world
        hand['authoringTargets'] = {'surfaceAnchorEngineM': ep(surface), 'wristTargetEngineM': ep(target),
            'wristTranslationEngineM': ep(delta), 'skinClearanceIfTranslatedRigidlyM': float(surface.z),
            'armPoseChanged': False}
        controls.append((side, wrist, baseline, proposed))
    scene['surface_target_scope'] = report['scope']
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 900, 600, 100
    scene.render.image_settings.file_format = 'PNG'
    scene.display.shading.light, scene.display.shading.color_type = 'STUDIO', 'MATERIAL'
    scene.display.shading.show_shadows, scene.display.shading.show_cavity = True, True
    scene.display.shading.background_type = 'WORLD'
    if scene.world is None:
        scene.world = bpy.data.worlds.new(case['id'] + ' contact world')
    scene.world.color = (.12, .14, .16)
    for side, wrist, baseline, proposed in controls:
        camera = bpy.data.objects.new(side + ' palm contact closeup', bpy.data.cameras.new('Palm side view'))
        scene.collection.objects.link(camera)
        center = wrist + Vector((0, -.075, 0))
        camera.location = center + Vector((.6 if side == 'L' else -.6, .12, .18))
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera.data.type, camera.data.ortho_scale = 'ORTHO', .45
        scene.camera = camera
        label_data = bpy.data.curves.new(side + ' target review caption', 'FONT')
        label_data.size = .008
        label = bpy.data.objects.new(label_data.name, label_data)
        scene.collection.objects.link(label)
        label.parent = camera
        label.location = (-.212, .125, -.5)
        label.show_in_front = True
        label.data.materials.append(material('Review caption', (.97, .97, .97)))
        for state in ['existing', 'target-proposal']:
            label_data.body = 'Existing pose: red wrist and skin' if state == 'existing' else 'Green target proposal; body pose unchanged'
            for _, _, old, new in controls:
                for obj in old:
                    obj.hide_render = state != 'existing'
                for obj in new:
                    obj.hide_render = state != 'target-proposal'
            filename = case['id'] + '-' + side + '-' + state + '.png'
            scene.render.filepath = str(output / filename)
            bpy.ops.render.render(write_still=True)
            report['renders'].append({'id': case['id'], 'side': side, 'state': state, 'file': filename,
                                      'timeSec': author_index / manifest['fps'], 'scope': 'Same original skin pose; markers show existing support or proposed target, not achieved arm correction.'})
        label.hide_render = True
    for _, _, old, new in controls:
        for obj in old + new:
            obj.hide_render = False
    report['cases'].append(row)
    print('PALM_SURFACE', json.dumps({'id': case['id'], 'hands': {side: {'summary': hand['summary'], 'targets': hand['authoringTargets']} for side, hand in row['hands'].items()}}), flush=True)

readme = bpy.data.texts.new('START HERE - palm skin surface authoring')
readme.write('The three extension-clearing Review scenes retain their full source animations. Bilateral editable palm surface anchors are on world zero at the saved middle review sample. Select an anchor and press G to author its placement; the derived wrist target follows with measured skin offset. The body is deliberately unchanged: these are target proposals, not accepted IK solutions. Red markers show the existing wrist and penetrating surface; green marks proposed positions. Full-cycle numeric measurements compare summed hand influence against dominant membership. Runtime arm solving and whole-body/native/host acceptance remain required.\n')
bpy.context.window.scene = bpy.data.scenes['Review male-extension-clearing']
project = output / 'palm-surface-authoring.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(project))
report['projectSha256'] = sha256(project)
(output / 'palm-surface-measurements.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
if sha256(project_path) != report['sourceProjectSha256'] or sha256(manifest_path) != report['sourceManifestSha256']:
    raise RuntimeError('Source inputs changed during authoring')
print('PALM_SURFACE_AUTHORING_READY', str(project), flush=True)
