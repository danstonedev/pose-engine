"""Add editable fixed palm and elbow targets to the kneeling skin proposal.

Blender --background --factory-startup --python-exit-code 1 --python THIS --
  <kneeling-support-proposal-folder> <fresh-output-folder>
Analytic IK is a geometric authoring aid, not clinical/runtime acceptance.
"""
import bpy
import hashlib
import json
import math
import sys
from pathlib import Path
from mathutils import Matrix, Vector

source, output = (Path(x).resolve() for x in sys.argv[sys.argv.index('--') + 1:][:2])
output.mkdir()
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
ep = lambda point: [float(point[0]), float(point[2]), -float(point[1])]
bpy.ops.wm.open_mainfile(filepath=str(source / 'kneeling-support-proposal.blend'))
report = {'version': 1, 'blenderVersion': bpy.app.version_string,
          'sourceProjectSha256': sha(source / 'kneeling-support-proposal.blend'),
          'sourceProposalSha256': sha(source / 'proposal.json'), 'scriptSha256': sha(Path(__file__)),
          'scope': 'Static editable geometric arm proposal over actual knee/dorsal-foot skin support. Fixed palm owners preserve the original setup hand orientation, with each hand skin minimum on world zero. Analytic IK changes only upperarm, forearm and hand controls. Runtime clinical/patient limits must independently validate these targets.',
          'criteriaBeforeFit': ['One fixed palm target per side across setup and peak.', 'No limb stretching.',
                               'Preserve lower-chain skin support.', 'Expose unreachable targets and any whole-body floor penetration.'],
          'cases': []}

def skin(rig):
    graph = bpy.context.evaluated_depsgraph_get()
    names = {side: set() for side in ['L', 'R']}
    for side in names:
        bone = rig.data.bones['CC_Base_' + side + '_Hand']
        names[side].update([bone.name, *(child.name for child in bone.children_recursive)])
    results = {key: [] for key in ['L', 'R', 'all', 'head', 'knee', 'foot', 'calf']}
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or not any(mod.type == 'ARMATURE' and mod.object == rig for mod in obj.modifiers):
            continue
        groups = {group.index: group.name for group in obj.vertex_groups}
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        for vertex in obj.data.vertices:
            if not vertex.groups:
                continue
            bone = groups[max(vertex.groups, key=lambda item: item.weight).group]
            point = evaluated.matrix_world @ mesh.vertices[vertex.index].co
            results['all'].append(point)
            for side in names:
                if bone in names[side]:
                    results[side].append(point)
            if 'Head' in bone or 'Neck' in bone:
                results['head'].append(point)
            if 'KneeShare' in bone:
                results['knee'].append(point)
            if any(text in bone for text in ['Foot', 'Toe']):
                results['foot'].append(point)
            if 'Calf' in bone:
                results['calf'].append(point)
        evaluated.to_mesh_clear()
    return results

def control(name, point):
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = point
    obj.empty_display_type = 'SPHERE'
    obj.empty_display_size = .015
    obj.show_in_front = True
    return obj

def world(rig, part):
    return rig.matrix_world @ rig.pose.bones['CC_Base_' + part].matrix

for variant in ['male', 'female', 'neutral']:
    reference = bpy.data.scenes['Review ' + variant + '-flexion-clearing']
    bpy.context.window.scene = reference
    reference.frame_set(0)
    bpy.context.view_layer.update()
    rig = next(obj for obj in reference.objects if obj.type == 'ARMATURE')
    source_skin = skin(rig)
    targets = {}
    for side in ['L', 'R']:
        hand_matrix = world(rig, side + '_Hand')
        hand_matrix.translation.z -= min(point.z for point in source_skin[side])
        targets[side] = hand_matrix
    # Choose the smallest shared longitudinal change that places both fixed
    # targets inside both endpoint reach spheres. This is geometric feasibility,
    # not a replacement for the runtime's shoulder/wrist/patient constraints.
    retreat = 0.0
    for phase in ['setup', 'peak']:
        scene = bpy.data.scenes['Author support ' + variant + ' ' + phase]
        bpy.context.window.scene = scene
        rig = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
        for side in ['L', 'R']:
            shoulder = world(rig, side + '_Upperarm').translation
            elbow = world(rig, side + '_Forearm').translation
            wrist = world(rig, side + '_Hand').translation
            target = targets[side].translation
            reach = (elbow - shoulder).length + (wrist - elbow).length - 1e-6
            perpendicular_sq = (target.x - shoulder.x) ** 2 + (target.z - shoulder.z) ** 2
            if perpendicular_sq >= reach ** 2:
                raise RuntimeError('Fixed hand height/width has no unstretched longitudinal solution')
            minimum_y = shoulder.y - math.sqrt(reach ** 2 - perpendicular_sq)
            retreat = max(retreat, minimum_y - target.y)
    for matrix in targets.values():
        matrix.translation.y += retreat
    for phase in ['setup', 'peak']:
        scene = bpy.data.scenes['Author support ' + variant + ' ' + phase]
        bpy.context.window.scene = scene
        rig = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
        arm_rows = []
        for side in ['L', 'R']:
            upper_name, forearm_name = side + '_Upperarm', side + '_Forearm'
            upper, forearm, hand = world(rig, upper_name), world(rig, forearm_name), world(rig, side + '_Hand')
            shoulder, elbow, wrist = upper.translation, forearm.translation, hand.translation
            target = targets[side].translation
            l1, l2 = (elbow - shoulder).length, (wrist - elbow).length
            distance = (target - shoulder).length
            item = {'side': side, 'shoulderEngineM': ep(shoulder), 'palmOwnerTargetEngineM': ep(target),
                    'upperArmLengthM': l1, 'forearmLengthM': l2, 'shoulderTargetDistanceM': distance,
                    'reachableWithoutStretch': abs(l1 - l2) < distance < l1 + l2}
            if not item['reachableWithoutStretch']:
                arm_rows.append(item)
                continue
            direction = (target - shoulder).normalized()
            perpendicular = elbow - shoulder - direction * (elbow - shoulder).dot(direction)
            perpendicular.normalize()
            along = (l1 * l1 - l2 * l2 + distance * distance) / (2 * distance)
            new_elbow = shoulder + direction * along + perpendicular * math.sqrt(max(0, l1 * l1 - along * along))
            upper_delta = (elbow - shoulder).rotation_difference(new_elbow - shoulder)
            upper_changed = Matrix.Translation(shoulder) @ upper_delta.to_matrix().to_4x4() @ Matrix.Translation(-shoulder) @ upper
            rig.pose.bones['CC_Base_' + upper_name].matrix = rig.matrix_world.inverted() @ upper_changed
            bpy.context.view_layer.update()
            forearm = world(rig, forearm_name)
            elbow_now, wrist_now = forearm.translation, world(rig, side + '_Hand').translation
            fore_delta = (wrist_now - elbow_now).rotation_difference(target - elbow_now)
            fore_changed = Matrix.Translation(elbow_now) @ fore_delta.to_matrix().to_4x4() @ Matrix.Translation(-elbow_now) @ forearm
            rig.pose.bones['CC_Base_' + forearm_name].matrix = rig.matrix_world.inverted() @ fore_changed
            bpy.context.view_layer.update()
            rig.pose.bones['CC_Base_' + side + '_Hand'].matrix = rig.matrix_world.inverted() @ targets[side]
            bpy.context.view_layer.update()
            reached = world(rig, side + '_Hand').translation
            item.update({'elbowGuideEngineM': ep(new_elbow), 'wristResidualM': (reached - target).length,
                         'geometricElbowFlexionDeg': 180 - math.degrees((shoulder - new_elbow).angle(target - new_elbow)),
                         'handWorldMatrixBlender': [list(row) for row in targets[side]]})
            control(side + ' FIXED PALM TARGET', target)
            control(side + ' ELBOW GUIDE', new_elbow)
            arm_rows.append(item)
        current_skin = skin(rig)
        minima = {key: min(point.z for point in points) for key, points in current_skin.items()}
        row = {'id': variant + '-' + phase, 'sharedPalmRetreatM': retreat,
               'arms': arm_rows, 'skinMinimumWorldY': minima}
        report['cases'].append(row)
        for view in ['Side', 'Overhead']:
            scene.camera = next(obj for obj in scene.objects if obj.type == 'CAMERA' and obj.name.startswith(view))
            scene.render.filepath = str(output / (row['id'] + '-' + view.lower() + '.png'))
            bpy.ops.render.render(write_still=True)
        scene.camera = next(obj for obj in scene.objects if obj.type == 'CAMERA' and obj.name.startswith('Side'))
        print('PALM_PROPOSAL', json.dumps(row), flush=True)

bpy.ops.wm.save_as_mainfile(filepath=str(output / 'kneeling-palms-proposal.blend'))
(output / Path(__file__).name).write_bytes(Path(__file__).read_bytes())
(output / 'proposal.json').write_text(json.dumps(report, indent=2) + '\n')
