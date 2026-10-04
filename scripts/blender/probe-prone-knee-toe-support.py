"""Sparse actual-skin pelvic/knee/toe coupling probe. No runtime promotion.
Blender --background --python-exit-code 1 --python <script> -- <author2> <fresh>
"""
import bpy
import hashlib
import json
import math
import sys
from pathlib import Path
from mathutils import Vector, Quaternion, Matrix
import numpy as np

source, output = [Path(p).resolve() for p in sys.argv[sys.argv.index('--') + 1:]]
output.mkdir()
data = json.loads((source / 'whole-chain-authoring.json').read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
report = {'schemaVersion': 1, 'blenderVersion': bpy.app.version_string,
          'blenderBuildHash': bpy.app.build_hash.decode(), 'scriptSha256': sha(Path(__file__)),
          'sourceProjectSha256': sha(source / 'whole-chain-authoring.blend'),
          'sourceReportSha256': sha(source / 'whole-chain-authoring.json'),
          'scope': 'Sparse geometric lower-chain feasibility probe on actual skin. No whole trajectory, clinical, dynamics or delivered-host acceptance.',
          'intent': 'Measure whether the distal thigh/knee/shin support envelope and distal toe skin can coexist with pelvic support; exclude proximal thigh/groin from the fitted region and retain complete-skin clearance as independent evidence.',
          'distalEnvelopeDefinition': 'Dominant calf vertices plus dominant thigh vertices at or beyond 50 percent of the hip-to-knee axis, selected on source posed skin. Excludes proximal thigh/groin; all skin is still checked for penetration.',
          'kneePatchDefinition': 'Dominant thigh/calf vertices within 10 percent of thigh length along the thigh axis from knee center, selected on the source posed skin. Entire circumferential band; lowest point is anterior support in prone.',
          'floorY': 0, 'cases': []}
bpy.ops.wm.open_mainfile(filepath=str(source / 'whole-chain-authoring.blend'))

def world(rig, bone): return rig.matrix_world @ bone.matrix
def rotate(rig, bone, degrees):
    m = world(rig, bone)
    bone.matrix = rig.matrix_world.inverted() @ Matrix.LocRotScale(m.translation, Quaternion((1, 0, 0), math.radians(degrees)) @ m.to_quaternion(), m.to_scale())
    bpy.context.view_layer.update()
def ep(v): return [float(v.x), float(v.z), float(-v.y)]

for case in data['cases']:
    for phase, frame in [('setup', 60), ('hold', 192)]:
        bpy.context.window.scene = bpy.data.scenes['Author whole chain ' + case['variant']]
        bpy.context.scene.frame_set(frame); bpy.context.view_layer.update()
        bpy.ops.scene.new(type='FULL_COPY')
        scene = bpy.context.scene; scene.name = 'Probe ' + case['variant'] + ' ' + phase
        rig = next(o for o in scene.objects if o.type == 'ARMATURE')
        root = next(o for o in scene.objects if o.name.startswith('ENGINE_ModelRoot'))
        for obj in scene.objects:
            if obj.animation_data: obj.animation_data_clear()
        scene.frame_start = scene.frame_end = frame
        bones = {side: {part: rig.pose.bones['CC_Base_' + side + '_' + part] for part in ['Thigh', 'Calf', 'Foot', 'ToeBase', 'Hand']} for side in ['L', 'R']}
        source_basis = {b.name: b.matrix_basis.copy() for b in rig.pose.bones}
        root_basis = root.matrix_basis.copy()
        hand_anchor = {side: world(rig, bones[side]['Hand']).translation.copy() for side in ['L', 'R']}
        regions = []
        graph = bpy.context.evaluated_depsgraph_get()
        for obj in scene.objects:
            if obj.type != 'MESH' or not any(m.type == 'ARMATURE' for m in obj.modifiers): continue
            groups = {g.index: g.name for g in obj.vertex_groups}
            owners = [groups[max(v.groups, key=lambda g: g.weight).group] if v.groups else '' for v in obj.data.vertices]
            evaluated = obj.evaluated_get(graph); mesh = evaluated.to_mesh()
            positions = [evaluated.matrix_world @ v.co for v in mesh.vertices]; evaluated.to_mesh_clear()
            masks = {'pelvis': [i for i, n in enumerate(owners) if n in ['CC_Base_Hip', 'CC_Base_Pelvis']]}
            for side in ['L', 'R']:
                hip = world(rig, bones[side]['Thigh']).translation; knee = world(rig, bones[side]['Calf']).translation
                thigh = knee - hip; length = thigh.length; direction = thigh.normalized()
                masks[side + ' knee'] = [i for i, n in enumerate(owners) if '_' + side + '_' in n and ('Thigh' in n or 'Calf' in n) and abs((positions[i] - knee).dot(direction)) <= .1 * length]
                masks[side + ' shin'] = [i for i, n in enumerate(owners) if '_' + side + '_' in n and 'Calf' in n]
                masks[side + ' leg envelope'] = [i for i, n in enumerate(owners) if '_' + side + '_' in n and ('Thigh' in n or 'Calf' in n)]
                masks[side + ' distal envelope'] = [i for i, n in enumerate(owners) if '_' + side + '_' in n and ('Calf' in n or ('Thigh' in n and (positions[i] - hip).dot(direction) >= .5 * length))]
                masks[side + ' toes'] = [i for i, n in enumerate(owners) if '_' + side + '_' in n and 'Toe' in n]
            regions.append((obj, {name: np.array(ids, dtype=np.int32) for name, ids in masks.items()}, owners))
        witnesses = {}
        def measure():
            values = {}; graph = bpy.context.evaluated_depsgraph_get()
            witnesses.clear()
            for obj, masks, owners in regions:
                evaluated = obj.evaluated_get(graph); mesh = evaluated.to_mesh()
                coords = np.empty(len(mesh.vertices) * 3); mesh.vertices.foreach_get('co', coords)
                matrix = np.array(evaluated.matrix_world); points = coords.reshape((-1, 3)) @ matrix[:3, :3].T + matrix[:3, 3]
                for name, ids in masks.items():
                    if not len(ids): continue
                    index = int(ids[np.argmin(points[ids, 2])])
                    if points[index, 2] < values.get(name, math.inf):
                        values[name] = float(points[index, 2]); witnesses[name] = {'mesh': obj.name, 'vertexIndex': index,
                            'dominantBone': owners[index], 'positionM': [float(points[index, 0]), float(points[index, 2]), float(-points[index, 1])]}
                index = int(np.argmin(points[:, 2]))
                if points[index, 2] < values.get('all', math.inf):
                    values['all'] = float(points[index, 2]); witnesses['all'] = {'mesh': obj.name, 'vertexIndex': index,
                        'dominantBone': owners[index], 'positionM': [float(points[index, 0]), float(points[index, 2]), float(-points[index, 1])]}
                evaluated.to_mesh_clear()
            return values
        before = measure()
        current = {side: np.zeros(2) for side in ['L', 'R']}
        def evaluate():
            root.matrix_basis = root_basis
            for side in ['L', 'R']:
                for part in ['Thigh', 'Calf']: bones[side][part].matrix_basis = source_basis[bones[side][part].name]
            bpy.context.view_layer.update()
            for side in ['L', 'R']:
                rotate(rig, bones[side]['Thigh'], float(current[side][0]))
                rotate(rig, bones[side]['Calf'], float(current[side][1]))
            for _ in range(2):
                root.location.z -= measure()['pelvis']; bpy.context.view_layer.update()
            return measure()
        traces = []
        for iteration in range(12):
            errors = []
            for side in ['L', 'R']:
                values = evaluate(); f = np.array([values[side + ' distal envelope'], values[side + ' toes']])
                errors.extend(abs(f)); jac = np.zeros((2, 2))
                for dof in range(2):
                    current[side][dof] += .1; test = evaluate(); current[side][dof] -= .1
                    jac[:, dof] = (np.array([test[side + ' distal envelope'], test[side + ' toes']]) - f) / .1
                try: correction = np.linalg.solve(jac, -f)
                except np.linalg.LinAlgError: break
                current[side] += np.clip(correction, -3, 3)
                current[side][0] = np.clip(current[side][0], -15, 15)
                current[side][1] = np.clip(current[side][1], 0, 25)
            traces.append({'iteration': iteration, 'maximumContactErrorM': max(errors), 'incrementalWorldPitchDeg': {s: current[s].tolist() for s in ['L', 'R']}})
            if max(errors) < .00005: break
        after = evaluate()
        for side in ['L', 'R']:
            for part in ['Thigh', 'Calf', 'Foot', 'ToeBase']:
                obj = bpy.data.objects.new('PROBE ' + side + ' ' + part + ' control', None)
                scene.collection.objects.link(obj); obj.empty_display_type = 'SPHERE'; obj.empty_display_size = .02
                obj.location = world(rig, bones[side][part]).translation; obj.show_in_front = True
                obj['scope'] = 'Measured lower-chain support proposal, not a clinical rig control'
        row = {'variant': case['variant'], 'phase': phase, 'sourceTimeSec': frame / case['sampleHz'],
               'skinBeforeM': before, 'skinAfterM': after, 'afterWitnesses': dict(witnesses), 'incrementalWorldPitchDeg': {s: {'hip': float(current[s][0]), 'knee': float(current[s][1])} for s in ['L', 'R']},
               'wristDisplacementM': {s: (world(rig, bones[s]['Hand']).translation - hand_anchor[s]).length for s in ['L', 'R']},
               'iterations': traces}
        report['cases'].append(row)
        print(case['variant'], phase, row['incrementalWorldPitchDeg'], after, flush=True)

bpy.ops.wm.save_as_mainfile(filepath=str(output / 'prone-knee-toe-probe.blend'))
report['projectSha256'] = sha(output / 'prone-knee-toe-probe.blend')
(output / 'prone-knee-toe-probe.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
