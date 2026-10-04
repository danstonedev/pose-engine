"""Author a small bilateral resting-hip rotation on actual Blender skin.
Retains source arms/spine and solves sagittal leg/toe support after each trial.
Blender --background --python-exit-code 1 --python <script> -- <review> <fresh>
"""
import bpy
import hashlib
import json
import math
import sys
from pathlib import Path
from mathutils import Vector, Quaternion, Matrix
import numpy as np

args = sys.argv[sys.argv.index('--') + 1:]
source, output = [Path(p).resolve() for p in args[:2]]
full_envelope = len(args) > 2 and args[2] == 'full-envelope'
output.mkdir()
manifest = json.loads((source / 'manifest.json').read_text())
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
report = {'version': 1, 'blenderVersion': bpy.app.version_string, 'blenderBuildHash': bpy.app.build_hash.decode(),
          'scriptSha256': sha(Path(__file__)), 'sourceProjectSha256': sha(source / 'full-motion-review.blend'),
          'sourceManifestSha256': sha(source / 'manifest.json'),
          'scope': 'Sparse geometric resting-hip authoring; source upper body unchanged. Local rotation clinical replay and dense motion remain required.',
          'supportObjective': 'full thigh/calf plus toes' if full_envelope else 'distal thigh/calf plus toes',
          'floorY': 0, 'cases': []}
bpy.ops.wm.open_mainfile(filepath=str(source / 'full-motion-review.blend'))

def world(rig, bone): return rig.matrix_world @ bone.matrix
def rotate(rig, bone, axis, degrees):
    m = world(rig, bone)
    bone.matrix = rig.matrix_world.inverted() @ Matrix.LocRotScale(m.translation,
        Quaternion(axis, math.radians(degrees)) @ m.to_quaternion(), m.to_scale())
    bpy.context.view_layer.update()

for case in manifest['cases']:
    bpy.context.window.scene = bpy.data.scenes['Review ' + case['id']]
    bpy.context.scene.frame_set(150); bpy.context.view_layer.update()
    bpy.ops.scene.new(type='FULL_COPY')
    scene = bpy.context.scene; scene.name = 'Authored resting hips ' + case['variant']
    rig = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
    root = next(obj for obj in scene.objects if obj.name.startswith('ENGINE_ModelRoot'))
    for obj in scene.objects:
        if obj.animation_data: obj.animation_data_clear()
    source_basis = {bone.name: bone.matrix_basis.copy() for bone in rig.pose.bones}
    root_basis = root.matrix_basis.copy()
    bones = {side: {part: rig.pose.bones['CC_Base_' + side + '_' + part] for part in ['Thigh', 'Calf', 'Foot', 'ToeBase', 'Hand']} for side in ['L', 'R']}
    regions = []
    graph = bpy.context.evaluated_depsgraph_get()
    for obj in scene.objects:
        if obj.type != 'MESH' or not any(modifier.type == 'ARMATURE' for modifier in obj.modifiers): continue
        names = {group.index: group.name for group in obj.vertex_groups}
        owners = [names[max(v.groups, key=lambda group: group.weight).group] if v.groups else '' for v in obj.data.vertices]
        evaluated = obj.evaluated_get(graph); mesh = evaluated.to_mesh()
        positions = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]; evaluated.to_mesh_clear()
        masks = {'pelvis': [i for i, name in enumerate(owners) if name in ['CC_Base_Hip', 'CC_Base_Pelvis']]}
        for side in ['L', 'R']:
            hip = world(rig, bones[side]['Thigh']).translation; knee = world(rig, bones[side]['Calf']).translation
            thigh = knee - hip; length = thigh.length; direction = thigh.normalized()
            masks[side + ' full-leg'] = [i for i, name in enumerate(owners) if '_' + side + '_' in name and ('Thigh' in name or 'Calf' in name or 'Foot' in name or 'Toe' in name)]
            masks[side + ' thigh-calf'] = [i for i, name in enumerate(owners) if '_' + side + '_' in name and ('Thigh' in name or 'Calf' in name)]
            masks[side + ' proximal-thigh'] = [i for i, name in enumerate(owners) if '_' + side + '_' in name and 'Thigh' in name and (positions[i] - hip).dot(direction) < .5 * length]
            masks[side + ' distal-envelope'] = [i for i, name in enumerate(owners) if '_' + side + '_' in name and ('Calf' in name or ('Thigh' in name and (positions[i] - hip).dot(direction) >= .5 * length))]
            masks[side + ' knee-band'] = [i for i, name in enumerate(owners) if '_' + side + '_' in name and ('Thigh' in name or 'Calf' in name) and abs((positions[i] - knee).dot(direction)) <= .1 * length]
            masks[side + ' toes'] = [i for i, name in enumerate(owners) if '_' + side + '_' in name and 'Toe' in name]
        regions.append((obj, {name: np.array(ids, dtype=np.int32) for name, ids in masks.items()}, owners))
    witnesses = {}
    def measure():
        values = {}; witnesses.clear(); graph = bpy.context.evaluated_depsgraph_get()
        for obj, masks, owners in regions:
            evaluated = obj.evaluated_get(graph); mesh = evaluated.to_mesh()
            coords = np.empty(len(mesh.vertices) * 3); mesh.vertices.foreach_get('co', coords)
            matrix = np.array(evaluated.matrix_world); points = coords.reshape((-1, 3)) @ matrix[:3, :3].T + matrix[:3, 3]
            for name, ids in masks.items():
                if not len(ids): continue
                index = int(ids[np.argmin(points[ids, 2])]); y = float(points[index, 2])
                if y < values.get(name, math.inf):
                    values[name] = y; witnesses[name] = {'mesh': obj.name, 'vertex': index, 'dominantBone': owners[index],
                        'positionM': [float(points[index, 0]), y, float(-points[index, 1])]}
            evaluated.to_mesh_clear()
        return values
    source_values = measure()
    rows = []
    best = None
    support_part = ' thigh-calf' if full_envelope else ' distal-envelope'
    for axial in ([0] if full_envelope else [0, -2, 2, -5, 5, -10, 10]):
        current = {side: np.zeros(2) for side in ['L', 'R']}
        def evaluate():
            root.matrix_basis = root_basis
            for bone in rig.pose.bones: bone.matrix_basis = source_basis[bone.name]
            bpy.context.view_layer.update()
            for side in ['L', 'R']:
                direction = (world(rig, bones[side]['Calf']).translation - world(rig, bones[side]['Thigh']).translation).normalized()
                rotate(rig, bones[side]['Thigh'], direction, axial * (1 if side == 'L' else -1))
                rotate(rig, bones[side]['Thigh'], Vector((1, 0, 0)), float(current[side][0]))
                rotate(rig, bones[side]['Calf'], Vector((1, 0, 0)), float(current[side][1]))
            # Preserve the same anterior pelvis support datum, not a blind lift
            # to whichever body part happens to be lowest after authoring.
            for unused in range(2):
                root.location.z -= measure()['pelvis']; bpy.context.view_layer.update()
            return measure()
        for iteration in range(12):
            maximum = 0
            for side in ['L', 'R']:
                values = evaluate(); error = np.array([values[side + support_part], values[side + ' toes']])
                maximum = max(maximum, float(np.max(np.abs(error))))
                jac = np.zeros((2, 2))
                for dof in range(2):
                    current[side][dof] += .1; test = evaluate(); current[side][dof] -= .1
                    jac[:, dof] = (np.array([test[side + support_part], test[side + ' toes']]) - error) / .1
                correction = np.linalg.lstsq(jac, -error, rcond=None)[0]
                current[side] += np.clip(correction, -2, 2)
                current[side] = np.clip(current[side], -10, 10)
            if maximum < .000025: break
        after = evaluate()
        score = max(-after[side + ' full-leg'] for side in ['L', 'R'])
        row = {'axialIncrementDeg': axial, 'hipKneeIncrementalWorldPitchDeg': {side: current[side].tolist() for side in ['L', 'R']},
               'skinM': after, 'witnesses': dict(witnesses), 'lowerSkinWorstPenetrationM': score}
        rows.append(row)
        if best is None or score < best['lowerSkinWorstPenetrationM']:
            best = row
            best_basis = {bone.name: bone.matrix_basis.copy() for bone in rig.pose.bones}; best_root = root.matrix_basis.copy()
        print(case['variant'], 'axial', axial, 'full leg', after['L full-leg'], after['R full-leg'], flush=True)
        if score >= -.00005 and score <= .00005: break
    root.matrix_basis = best_root
    for bone in rig.pose.bones: bone.matrix_basis = best_basis[bone.name]
    bpy.context.view_layer.update()
    for side in ['L', 'R']:
        for part in ['Thigh', 'Calf', 'Foot', 'ToeBase', 'Hand']:
            control = bpy.data.objects.new('AUTHOR ' + side + ' ' + part + ' anchor', None); scene.collection.objects.link(control)
            control.empty_display_type = 'SPHERE'; control.empty_display_size = .018
            control.location = world(rig, bones[side][part]).translation; control.show_in_front = True
            control['scope'] = 'Editable geometry review marker; no independent runtime controller'
    report['cases'].append({'variant': case['variant'], 'sourceTimeMs': 2500, 'sourceSkinM': source_values, 'trials': rows, 'selected': best})
bpy.ops.wm.save_as_mainfile(filepath=str(output / 'authored-prone-thigh-rest.blend'))
report['projectSha256'] = sha(output / 'authored-prone-thigh-rest.blend')
(output / 'authored-prone-thigh-rest.json').write_text(json.dumps(report, indent=2) + '\n')
