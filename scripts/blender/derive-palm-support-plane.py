"""Author palm support-plane targets from actual skin convex support geometry.

Blender --background --factory-startup --python-exit-code 1 --python
  scripts/blender/derive-palm-support-plane.py -- <review-folder> <fresh-output>
Creates measured orientation targets and isolated rigid-hand previews. Full body
motions are retained unchanged; clinically bounded arm IK must adopt the targets.
"""
import bpy
import bmesh
import hashlib
import json
import math
import sys
from pathlib import Path
from mathutils import Vector
import numpy as np

source, output = [Path(value).resolve() for value in sys.argv[sys.argv.index('--') + 1:][:2]]
output.mkdir()
manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8-sig'))
hash_file = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
ep = lambda value: [float(value[0]), float(value[2]), float(-value[1])]
report = {'schemaVersion': 1, 'sourceDigest': manifest['sourceDigest'], 'blenderVersion': bpy.app.version_string,
          'sourceManifestSha256': hash_file(source / 'manifest.json'),
          'sourceProjectSha256': hash_file(source / 'full-motion-review.blend'), 'scriptSha256': hash_file(Path(__file__)),
          'scope': 'Geometric supporting-plane targets and isolated rigid-hand previews. Original whole-body motion unchanged. Arm ROM, native loads, skin compression and delivered runtime remain unqualified.',
          'criteriaBeforeSearch': {'floorY': 0, 'maximumCandidateNormalDeviationDeg': 25,
              'primaryObjective': 'Minimize maximum geometric separation of heel, thenar and ulnar palm patches while all selected hand skin lies above the plane.',
              'secondaryObjective': 'Minimize deviation from original metacarpal-bone normal.',
              'patches': 'Voronoi regions in the bone-derived palm tangent plane nearest wrist center (heel), Thumb1 center (thenar), and Pinky1 center (ulnar). Thenar and ulnar regions must also lie on the corresponding landmark side of the longitudinal palm midline. Restrict to Hand- or Thumb1-dominant skin proximal to furthest metacarpal landmark. These are geometric labels, not clinical pressure regions.'},
          'cases': []}
bpy.ops.wm.open_mainfile(filepath=str(source / 'full-motion-review.blend'))

def mat(name, color):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*color, 1)
    return material

skin_material = mat('Measured hand skin', (.72, .78, .8))
floor_material = mat('Explicit world-zero plane', (.16, .22, .25))
contact_material = mat('Palm contact patches', (.1, .85, .35))

for case in manifest['cases']:
    if case['movement'] != 'extension-clearing':
        continue
    scene = bpy.data.scenes['Review ' + case['id']]
    bpy.context.window.scene = scene
    index = case['holdFrame'] - 1
    scene.frame_set(index)
    graph = bpy.context.evaluated_depsgraph_get()
    rig = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
    rig_eval = rig.evaluated_get(graph)
    row = {'id': case['id'], 'variant': case['variant'], 'timeSec': index / manifest['fps'],
           'durationMs': case['durationMs'], 'sourceModelSha256': case['sourceModelSha256'], 'glbSha256': case['glbSha256'], 'hands': {}}
    for side in ['L', 'R']:
        hand_name = 'CC_Base_' + side + '_Hand'
        descendants = {hand_name, *(bone.name for bone in rig.data.bones[hand_name].children_recursive)}
        def landmark(part):
            return (rig_eval.matrix_world @ rig_eval.pose.bones['CC_Base_' + side + '_' + part].matrix).translation
        wrist = landmark('Hand')
        forward = (landmark('Mid1') - wrist).normalized()
        palmar = forward.cross(landmark('Index1') - landmark('Pinky1')).normalized() * (1 if side == 'L' else -1)
        lateral = palmar.cross(forward).normalized()
        basis = np.array([forward, lateral, palmar]).T
        anchors = np.array([(landmark(part) - wrist) for part in ['Hand', 'Thumb1', 'Pinky1']]) @ basis
        distal_limit = max((landmark(part) - wrist).dot(forward) for part in ['Index1', 'Mid1', 'Ring1', 'Pinky1'])
        positions, palm_mask, mesh_records = [], [], []
        for obj in scene.objects:
            if obj.type != 'MESH' or not any(mod.type == 'ARMATURE' and mod.object == rig for mod in obj.modifiers):
                continue
            names = {group.index: group.name for group in obj.vertex_groups}
            selected, dominant = [], {}
            for vertex in obj.data.vertices:
                if sum(item.weight for item in vertex.groups if names[item.group] in descendants) >= .5:
                    selected.append(vertex.index)
                    dominant[vertex.index] = names[max(vertex.groups, key=lambda item: item.weight).group]
            if not selected:
                continue
            evaluated = obj.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            coords = np.empty(len(mesh.vertices) * 3)
            mesh.vertices.foreach_get('co', coords)
            matrix = np.array(evaluated.matrix_world)
            world = coords.reshape((-1, 3)) @ matrix[:3, :3].T + matrix[:3, 3]
            local = (world[selected] - np.array(wrist)) @ basis
            positions.extend(local)
            palm_mask.extend(dominant[vertex] in [hand_name, 'CC_Base_' + side + '_Thumb1'] and local[i, 0] <= distal_limit
                             for i, vertex in enumerate(selected))
            mapping = {value: i for i, value in enumerate(selected)}
            faces = [[mapping[vertex] for vertex in face.vertices] for face in mesh.polygons if all(vertex in mapping for vertex in face.vertices)]
            mesh_records.append({'name': obj.name, 'world': world[selected], 'faces': faces})
            evaluated.to_mesh_clear()
        cloud = np.array(positions)
        is_palm = np.array(palm_mask)
        nearest = np.argmin(np.linalg.norm(cloud[:, None, :2] - anchors[None, :, :2], axis=2), axis=1)
        patches = {label: np.flatnonzero(is_palm & (nearest == i)) for i, label in enumerate(['heel', 'thenar', 'ulnar'])}
        for label, landmark_index in [('thenar', 1), ('ulnar', 2)]:
            indices = patches[label]
            patches[label] = indices[cloud[indices, 1] * anchors[landmark_index, 1] > 0]
        if any(not len(indices) for indices in patches.values()):
            raise RuntimeError('Missing anatomical palm patch')
        hull = bmesh.new()
        for point in cloud:
            hull.verts.new(point)
        bmesh.ops.convex_hull(hull, input=list(hull.verts), use_existing_faces=False)
        hull.normal_update()
        candidates = [np.array([0., 0., 1.])]
        for face in hull.faces:
            normal = np.array(face.normal)
            if normal[2] >= math.cos(math.radians(25)):
                candidates.append(normal / np.linalg.norm(normal))
        hull.free()
        def assess(normal):
            depth = float(np.max(cloud @ normal))
            clearance = depth - cloud @ normal
            points = {label: int(indices[np.argmin(clearance[indices])]) for label, indices in patches.items()}
            gaps = {label: float(clearance[index]) for label, index in points.items()}
            angle = math.degrees(math.acos(float(np.clip(normal[2], -1, 1))))
            return {'normal': normal, 'depth': depth, 'gaps': gaps, 'points': points,
                    'maxGap': max(gaps.values()), 'angle': angle, 'minimumClearance': float(clearance.min()),
                    'nearContactCountsWithin2mm': {label: int(np.count_nonzero(clearance[indices] <= .002)) for label, indices in patches.items()}}
        original = assess(candidates[0])
        best = min(map(assess, candidates), key=lambda candidate: (round(candidate['maxGap'], 8), candidate['angle']))
        normal_world = Vector(basis @ best['normal'])
        delta = normal_world.rotation_difference(Vector((0, 0, -1)))
        target = wrist.copy()
        target.z = best['depth']
        source_hand_q = (rig_eval.matrix_world @ rig_eval.pose.bones[hand_name].matrix).to_quaternion()
        candidate_q = delta @ source_hand_q
        contact_points = [cloud[index] for index in best['points'].values()]
        span = max(float(np.linalg.norm(a - b)) for a in contact_points for b in contact_points)
        area = float(np.linalg.norm(np.cross(contact_points[1] - contact_points[0], contact_points[2] - contact_points[0])) / 2)
        hand = {'handVertices': len(cloud), 'palmPatchCounts': {key: len(value) for key, value in patches.items()},
                'patchLandmarksInAnatomicalPalmFrameM': dict(zip(['heel', 'thenar', 'ulnar'], anchors.tolist())),
                'candidatePlanes': len(candidates), 'sourceWristEngineM': ep(wrist), 'targetWristEngineM': ep(target),
                'targetSkinNormalInAnatomicalPalmFrame': best['normal'].tolist(),
                'sourceMetacarpalNormalEngine': ep(palmar), 'sourceSupportingNormalEngine': ep(normal_world),
                'deltaOrientationEngineXYZW': [delta.x, delta.z, -delta.y, delta.w],
                'targetHandOrientationEngineXYZW': [candidate_q.x, candidate_q.z, -candidate_q.y, candidate_q.w],
                'normalDeviationDeg': best['angle'], 'rollAboutFingerAxisDeg': math.degrees(math.atan2(best['normal'][1], best['normal'][2])),
                'pitchAboutAcrossPalmAxisDeg': math.degrees(math.atan2(best['normal'][0], best['normal'][2])),
                'supportDepthM': best['depth'], 'wholeHandMinimumClearanceM': best['minimumClearance'],
                'originalPatchClearancesM': original['gaps'], 'candidatePatchClearancesM': best['gaps'],
                'nearContactCountsWithin2mm': best['nearContactCountsWithin2mm'],
                'contactSpanM': span, 'contactTriangleAreaM2': area,
                'contactPatchPointsInAnatomicalPalmFrameM': {label: cloud[index].tolist() for label, index in best['points'].items()},
                'scope': 'Geometric target; no whole-body IK mutation. Bone-local orientation equivalence and clinical bounds require runtime verification.'}
        row['hands'][side] = hand
        # The isolated surface preview moves this measured rigid hand only.
        # It is separate from the retained whole-body animation and arm rig.
        preview = bpy.data.scenes.new('Palm target ' + case['variant'] + ' ' + side)
        bpy.context.window.scene = preview
        control = bpy.data.objects.new(side + ' editable supported wrist', None)
        preview.collection.objects.link(control)
        control.empty_display_type, control.empty_display_size = 'ARROWS', .025
        control.location, control.rotation_mode, control.rotation_quaternion = target, 'QUATERNION', delta
        control['geometry_derived_normal'] = best['normal'].tolist()
        control['target_hand_orientation_engine_xyzw'] = hand['targetHandOrientationEngineXYZW']
        control['scope'] = hand['scope']
        for mesh_record in mesh_records:
            mesh = bpy.data.meshes.new('Measured isolated ' + mesh_record['name'])
            mesh.from_pydata(mesh_record['world'] - np.array(wrist), [], mesh_record['faces'])
            obj = bpy.data.objects.new(mesh.name, mesh)
            preview.collection.objects.link(obj)
            obj.parent = control
            mesh.materials.append(skin_material)
        for label, index in best['points'].items():
            location = target + delta @ Vector(basis @ cloud[index])
            bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=.0025, location=location)
            marker = bpy.context.object
            marker.name = label + ' measured palm support'
            marker.show_in_front = True
            marker.data.materials.append(contact_material)
        bpy.ops.mesh.primitive_plane_add(size=5, location=(0, 0, 0))
        bpy.context.object.data.materials.append(floor_material)
        camera = bpy.data.objects.new('Matched palm support camera', bpy.data.cameras.new('Palm support side'))
        preview.collection.objects.link(camera)
        center = target + forward * .075
        camera.location = center + Vector((.5 if side == 'L' else -.5, .12, .19))
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera.data.type, camera.data.ortho_scale = 'ORTHO', .38
        preview.camera = camera
        preview.render.engine = 'BLENDER_WORKBENCH'
        preview.render.resolution_x, preview.render.resolution_y, preview.render.resolution_percentage = 900, 600, 100
        preview.display.shading.color_type = 'MATERIAL'
        preview.display.shading.show_shadows, preview.display.shading.show_cavity = True, True
        for mode in ['existing', 'derived-plane-target']:
            control.location = wrist if mode == 'existing' else target
            control.rotation_quaternion = delta if mode != 'existing' else (1, 0, 0, 0)
            for obj in preview.objects:
                if 'measured palm support' in obj.name:
                    obj.hide_render = mode == 'existing'
            filename = case['variant'] + '-' + side + '-' + mode + '.png'
            preview.render.filepath = str(output / filename)
            bpy.ops.render.render(write_still=True)
        bpy.context.window.scene = scene
    report['cases'].append(row)
    print('PALM_PLANE', json.dumps(row), flush=True)

readme = bpy.data.texts.new('START HERE - skin-derived palm support plane')
readme.write('Original Review scenes retain the full body animation. Palm target scenes contain isolated hand skin at a geometrically derived support-plane target. The target wrist control is editable with G/R. Green markers identify heel, thenar and ulnar nearest surface support patches. No full arm or body was silently moved. These are orientation targets for the bounded engine solver, not accepted whole-body motion or native pressure results.\n')
bpy.context.window.scene = bpy.data.scenes['Palm target male L']
project = output / 'palm-support-plane.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(project))
report['projectSha256'] = hash_file(project)
(output / 'palm-support-plane.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
if hash_file(source / 'full-motion-review.blend') != report['sourceProjectSha256']:
    raise RuntimeError('Source project changed')
print('PALM_SUPPORT_PLANE_READY', str(project), flush=True)
