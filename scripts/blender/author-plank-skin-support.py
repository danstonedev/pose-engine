"""Editable actual-skin toe and palm proposal from a retained production review.

Blender --background --factory-startup --threads 2 --python-exit-code 1
  --python THIS -- <review-folder> <fresh-output-folder>
Static geometric authoring only; bounded clinical replay is a separate gate.
"""
import bpy
import bmesh
import hashlib
import json
import math
import sys
from pathlib import Path
from mathutils import Matrix, Vector
import numpy as np

args = sys.argv[sys.argv.index('--') + 1:]
source, output = (Path(x).resolve() for x in args[:2])
fit_fixed_layout = '--fit-fixed-layout' in args[2:]
top_pitch_delta_deg = 2.0 if '--top-pitch-plus-2' in args[2:] else 0.0
fit_top_placement = '--fit-top-placement' in args[2:]
output.mkdir()
manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8-sig'))
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
ep = lambda p: [float(p.x), float(p.z), float(-p.y)]
eq = lambda q: [float(q.x), float(q.z), float(-q.y), float(q.w)]
report = {'version': 1, 'sourceDigest': manifest['sourceDigest'],
          'sourceManifestSha256': sha(source / 'manifest.json'),
          'sourceProjectSha256': sha(source / 'full-motion-review.blend'),
          'scriptSha256': sha(Path(__file__)), 'blenderVersion': bpy.app.version_string,
          'floorY': 0,
          'fixedLayoutFitRequested': fit_fixed_layout,
          'topPitchDeltaDegRequested': top_pitch_delta_deg,
          'topPlacementFitRequested': fit_top_placement,
          'scope': 'Static toe/foot skin grounding and fixed skin-derived palm anchors on actual rigs. Lower-chain local rotations and original root pitch remain unchanged. Geometric arm IK retains the original elbow branch and never stretches. This proposal does not prove clinical or patient bounds, full-cycle planted contact, pressure, native dynamics or delivered playback.',
          'criteriaBeforeFit': [
              'World-zero toe/foot skin supports; no bone-center or hidden floor offset.',
              'One fixed palm anchor/orientation per side shared by setup, pressed top and return.',
              'No leg local rotation, body-proportion or root-pitch change; report all lower skin and head clearance.',
              'No arm stretch; expose unreachable anchors and whole-skin penetration.',
              'Existing clinical and patient bounds must be applied independently in the runtime transfer.'
          ], 'cases': []}
bpy.ops.wm.open_mainfile(filepath=str(source / 'full-motion-review.blend'))

def world(rig, name):
    return rig.matrix_world @ rig.pose.bones['CC_Base_' + name].matrix

def skin(rig):
    graph = bpy.context.evaluated_depsgraph_get()
    data = []
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or not any(mod.type == 'ARMATURE' and mod.object == rig for mod in obj.modifiers):
            continue
        groups = {group.index: group.name for group in obj.vertex_groups}
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        if len(mesh.vertices) != len(obj.data.vertices):
            raise RuntimeError('Evaluated topology changed')
        for vertex in obj.data.vertices:
            if vertex.groups:
                owner = groups[max(vertex.groups, key=lambda item: item.weight).group]
                point = evaluated.matrix_world @ mesh.vertices[vertex.index].co
                data.append((point, owner))
        evaluated.to_mesh_clear()
    return data

def region(owner):
    side = 'L' if '_L_' in owner else 'R' if '_R_' in owner else 'center'
    for key, label in [('Toe', 'toes'), ('Foot', 'foot'), ('Calf', 'calf'), ('Knee', 'knee'),
                       ('Thigh', 'thigh'), ('Forearm', 'forearm'), ('Upperarm', 'upperarm'),
                       ('Head', 'head'), ('Neck', 'neck')]:
        if key in owner:
            return side + ' ' + label
    if any(x in owner for x in ['Hand', 'Thumb', 'Index', 'Mid', 'Ring', 'Pinky']):
        return side + ' palm/fingers'
    return 'torso/other'

def minima(data):
    values = {'all': min(p.z for p, _ in data)}
    for p, owner in data:
        key = region(owner)
        values[key] = min(values.get(key, float('inf')), p.z)
    return values

def control(name, matrix):
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.matrix_world = matrix
    obj.empty_display_type = 'ARROWS'
    obj.empty_display_size = .025
    obj.show_in_front = True
    return obj

def palm_target(rig, side, data):
    # Same convex support-plane and geometric patch method as the retained
    # derive-palm-support-plane.py authoring tool. Labels do not imply pressure.
    hand_name = 'CC_Base_' + side + '_Hand'
    descendants = {hand_name, *(b.name for b in rig.data.bones[hand_name].children_recursive)}
    wrist = world(rig, side + '_Hand').translation
    landmark = lambda part: world(rig, side + '_' + part).translation
    forward = (landmark('Mid1') - wrist).normalized()
    palmar = forward.cross(landmark('Index1') - landmark('Pinky1')).normalized() * (1 if side == 'L' else -1)
    lateral = palmar.cross(forward).normalized()
    basis = np.array([forward, lateral, palmar]).T
    anchors = np.array([(landmark(part) - wrist) for part in ['Hand', 'Thumb1', 'Pinky1']]) @ basis
    distal = max((landmark(part) - wrist).dot(forward) for part in ['Index1', 'Mid1', 'Ring1', 'Pinky1'])
    selected = [(p, owner) for p, owner in data if owner in descendants]
    cloud = np.array([p - wrist for p, _ in selected]) @ basis
    is_palm = np.array([owner in [hand_name, 'CC_Base_' + side + '_Thumb1'] and p[0] <= distal
                       for p, (_, owner) in zip(cloud, selected)])
    nearest = np.argmin(np.linalg.norm(cloud[:, None, :2] - anchors[None, :, :2], axis=2), axis=1)
    patches = {label: np.flatnonzero(is_palm & (nearest == i)) for i, label in enumerate(['heel', 'thenar', 'ulnar'])}
    for label, index in [('thenar', 1), ('ulnar', 2)]:
        ids = patches[label]
        patches[label] = ids[cloud[ids, 1] * anchors[index, 1] > 0]
    if any(not len(ids) for ids in patches.values()):
        raise RuntimeError('Missing geometric palm patch')
    hull = bmesh.new()
    for point in cloud:
        hull.verts.new(point)
    bmesh.ops.convex_hull(hull, input=list(hull.verts), use_existing_faces=False)
    hull.normal_update()
    normals = [np.array([0., 0., 1.])]
    for face in hull.faces:
        normal = np.array(face.normal)
        if normal[2] >= math.cos(math.radians(25)):
            normals.append(normal / np.linalg.norm(normal))
    hull.free()
    def assess(normal):
        depth = float(np.max(cloud @ normal))
        clearance = depth - cloud @ normal
        ids = {label: int(values[np.argmin(clearance[values])]) for label, values in patches.items()}
        gaps = {label: float(clearance[index]) for label, index in ids.items()}
        return {'normal': normal, 'depth': depth, 'gaps': gaps,
                'maxGap': max(gaps.values()), 'angle': math.degrees(math.acos(float(np.clip(normal[2], -1, 1))))}
    best = min(map(assess, normals), key=lambda a: (round(a['maxGap'], 8), a['angle']))
    normal_world = Vector(basis @ best['normal'])
    delta = normal_world.rotation_difference(Vector((0, 0, -1)))
    original = world(rig, side + '_Hand')
    # Retain the source's world scale. Rebuilding from a quaternion alone
    # replaces the imported 0.01-scale hand by a metre-scale rigid hand.
    target = delta.to_matrix().to_4x4() @ original
    target.translation = Vector((wrist.x, wrist.y, best['depth']))
    return target, {'targetWristEngineM': ep(target.translation),
                    'targetHandOrientationEngineXYZW': eq(target.to_quaternion()),
                    'sourceSupportingNormalEngine': ep(normal_world),
                    'targetNormalEngine': [0, -1, 0],
                    'normalDeviationDeg': best['angle'], 'supportDepthM': best['depth'],
                    'candidatePatchClearancesM': best['gaps'],
                    'patchCounts': {key: len(value) for key, value in patches.items()},
                    'method': 'Actual dominant hand/digit skin convex supporting plane; geometric heel/thenar/ulnar labels; same search interval/objective as existing palm authoring tool.'}

def solve_arm(rig, side, target):
    upper, fore, hand = [world(rig, side + '_' + name) for name in ['Upperarm', 'Forearm', 'Hand']]
    shoulder, elbow, wrist = upper.translation, fore.translation, hand.translation
    point = target.translation
    l1, l2, distance = (elbow - shoulder).length, (wrist - elbow).length, (point - shoulder).length
    row = {'side': side, 'lengthsM': [l1, l2], 'shoulderTargetDistanceM': distance,
           'reachableWithoutStretch': abs(l1 - l2) < distance < l1 + l2}
    if not row['reachableWithoutStretch']:
        return row
    direction = (point - shoulder).normalized()
    bend = elbow - shoulder - direction * (elbow - shoulder).dot(direction)
    bend.normalize()
    along = (l1*l1 - l2*l2 + distance*distance) / (2*distance)
    new_elbow = shoulder + direction * along + bend * math.sqrt(max(0, l1*l1 - along*along))
    upper_delta = (elbow - shoulder).rotation_difference(new_elbow - shoulder)
    changed = Matrix.Translation(shoulder) @ upper_delta.to_matrix().to_4x4() @ Matrix.Translation(-shoulder) @ upper
    rig.pose.bones['CC_Base_' + side + '_Upperarm'].matrix = rig.matrix_world.inverted() @ changed
    bpy.context.view_layer.update()
    fore = world(rig, side + '_Forearm')
    elbow_now, wrist_now = fore.translation, world(rig, side + '_Hand').translation
    fore_delta = (wrist_now - elbow_now).rotation_difference(point - elbow_now)
    changed = Matrix.Translation(elbow_now) @ fore_delta.to_matrix().to_4x4() @ Matrix.Translation(-elbow_now) @ fore
    rig.pose.bones['CC_Base_' + side + '_Forearm'].matrix = rig.matrix_world.inverted() @ changed
    bpy.context.view_layer.update()
    rig.pose.bones['CC_Base_' + side + '_Hand'].matrix = rig.matrix_world.inverted() @ target
    bpy.context.view_layer.update()
    row.update({'wristResidualM': (world(rig, side + '_Hand').translation - point).length,
                'geometricElbowFlexionDeg': 180 - math.degrees((shoulder-new_elbow).angle(point-new_elbow)),
                'humerusWorldRotationChangeDeg': math.degrees(upper_delta.angle),
                'elbowGuideEngineM': ep(new_elbow)})
    control(side + ' fixed skin-derived palm target', target)
    guide = Matrix.Translation(new_elbow)
    control(side + ' retained elbow branch guide', guide)
    return row

def fitted_top_placement(rig, targets):
    """One root pitch, original fixed palms, actual posed foot/toe support."""
    pivot=(world(rig,'L_ToeBase').translation+world(rig,'R_ToeBase').translation)/2
    all_skin=skin(rig)
    foot=np.array([point for point,owner in all_skin if region(owner).endswith((' toes',' foot'))])
    pivot_np=np.array(pivot)
    data={}
    for side in ['L','R']:
        shoulder,elbow,wrist=[world(rig,side+'_'+part).translation for part in ['Upperarm','Forearm','Hand']]
        l1,l2=(elbow-shoulder).length,(wrist-elbow).length
        data[side]={'shoulder':np.array(shoulder),'target':np.array(targets[side][0].translation),
                    'l1':l1,'l2':l2,'straight':l1+l2,
                    'margin':math.sqrt(l1*l1+l2*l2+2*l1*l2*math.cos(math.radians(5)))}
    def distances(deg):
        rotation=np.array(Matrix.Rotation(math.radians(deg),3,'X'))
        rotated_foot=(foot-pivot_np) @ rotation.T+pivot_np
        lift=-float(rotated_foot[:,2].min())
        out={}
        for side,value in data.items():
            shoulder=(value['shoulder']-pivot_np) @ rotation.T+pivot_np+np.array([0,0,lift])
            distance=float(np.linalg.norm(shoulder-value['target']))
            cosine=np.clip((distance*distance-value['l1']**2-value['l2']**2)/(2*value['l1']*value['l2']),-1,1)
            out[side]={'distanceM':distance,'fullStraightReachM':value['straight'],
                       'fiveDegreeSeedReachM':value['margin'],
                       'straightDistanceResidualM':distance-value['straight'],
                       'fiveDegreeDistanceResidualM':distance-value['margin'],
                       'geometricElbowFlexionDeg':math.degrees(math.acos(float(cosine))),
                       'shoulderEngineM':[float(shoulder[0]),float(shoulder[2]),float(-shoulder[1])]}
        return out
    grid=np.linspace(-10,10,201)
    def roots(fn):
        results=[]
        for low,high in zip(grid[:-1],grid[1:]):
            a,b=fn(float(low)),fn(float(high))
            if a*b > 0:
                continue
            lo,hi=float(low),float(high)
            for _ in range(40):
                mid=(lo+hi)/2
                if fn(lo)*fn(mid)<=0:
                    hi=mid
                else:
                    lo=mid
            results.append((lo+hi)/2)
        return results
    individual={side:{kind:roots(lambda angle:distances(angle)[side][metric])
                      for kind,metric in [('fullStraightPitchDeltaDeg','straightDistanceResidualM'),
                                          ('fiveDegreePitchDeltaDeg','fiveDegreeDistanceResidualM')]}
                for side in ['L','R']}
    candidates=roots(lambda angle:max(value['fiveDegreeDistanceResidualM'] for value in distances(angle).values()))
    if not candidates:
        raise RuntimeError('No jointly reachable root placement in stated +/-10degree geometric search')
    angle=min(candidates,key=abs)
    return angle,{'criteriaBeforeSearch':{'fixedPalmXZ':True,'fixedPalmOrientation':True,
                   'lowerLocalRotations': 'unchanged','rootPitchSearchDeltaDeg':[-10,10],
                   'objective':'Smallest absolute root pitch change with both arms within the existing authored5degree geometric elbow seed reach; no segment stretch.',
                   'clinicalStatus':'Geometric feasibility only; runtime patient/shoulder/wrist limits still mandatory.'},
                 'individualArmRoots':individual,'selectedPitchDeltaDeg':angle,
                 'selectedRootPitchDeg':76+angle,'selectedSideDistances':distances(angle),
                 'candidatesPitchDeltaDeg':candidates,
                 'unchangedPlacementSideDistances':distances(0)}

floor_material = bpy.data.materials.new('World-zero geometric support')
floor_material.diffuse_color = (.26, .30, .33, 1)
for case in manifest['cases']:
    reference = bpy.data.scenes['Review ' + case['id']]
    bpy.context.window.scene = reference
    reference.frame_set(0)
    bpy.context.view_layer.update()
    reference_rig = next(o for o in reference.objects if o.type == 'ARMATURE')
    data = skin(reference_rig)
    targets = {side: palm_target(reference_rig, side, data) for side in ['L', 'R']}
    fixed_retreat = 0.0
    fixed_retreat_limit = float('inf')
    layout_rows = []
    if fit_fixed_layout:
        # The original top seed commands 5-degree elbow flexion. Preserve that
        # geometric margin rather than fitting exactly on the stretch boundary.
        for seconds in [0, 2.5, case['durationMs']/1000]:
            clock = seconds * manifest['fps']
            reference.frame_set(math.floor(clock), subframe=clock-math.floor(clock))
            bpy.context.view_layer.update()
            minimum = min(value for key,value in minima(skin(reference_rig)).items() if key.endswith((' foot',' toes')))
            for side in ['L','R']:
                shoulder,elbow,wrist = [world(reference_rig,side+'_'+part).translation for part in ['Upperarm','Forearm','Hand']]
                l1,l2 = (elbow-shoulder).length,(wrist-elbow).length
                shoulder.z -= minimum
                target = targets[side][0].translation
                max_reach_sq = l1*l1 + l2*l2 + 2*l1*l2*math.cos(math.radians(5))
                other_sq = (target.x-shoulder.x)**2 + (target.z-shoulder.z)**2
                if other_sq >= max_reach_sq:
                    raise RuntimeError('Fixed hand height/width cannot reach without changing source top placement')
                extent = math.sqrt(max_reach_sq-other_sq)
                low,high = shoulder.y-extent-target.y,shoulder.y+extent-target.y
                fixed_retreat=max(fixed_retreat,low)
                fixed_retreat_limit=min(fixed_retreat_limit,high)
                layout_rows.append({'sourceTimeSec':seconds,'side':side,'minimumRetreatM':low,
                                    'maximumRetreatM':high,'upperArmLengthM':l1,
                                    'reachMarginBasis':'Existing authored top elbow seed5deg; geometric no-stretch margin, not clinical validation.'})
        if fixed_retreat > fixed_retreat_limit:
            raise RuntimeError('No single longitudinal layout fits all endpoint reach spheres')
        for side,value in targets.items():
            value[0].translation.y += fixed_retreat
            value[1]['targetWristEngineM']=ep(value[0].translation)
            value[1]['sharedLongitudinalRetreatM']=fixed_retreat
            value[1]['sharedLongitudinalRetreatUpperArmRatio']=fixed_retreat/layout_rows[0]['upperArmLengthM']
    # Exact retained recipe phase clocks: prepared prone start 0, fully pressed
    # endpoint 2.5 s, identical returned prone endpoint 5.6 s.
    for phase, seconds in [('setup-bottom', 0), ('pressed-top', 2.5), ('returned-bottom', case['durationMs']/1000)]:
        scene = bpy.data.scenes.new('Author toe-palm ' + case['variant'] + ' ' + phase)
        bpy.context.window.scene = scene
        scene.render.fps = manifest['fps']
        bpy.ops.import_scene.gltf(filepath=str(source / case['file']), bone_heuristic='BLENDER', guess_original_bind_pose=True)
        actors = list(scene.objects)
        rig = next(o for o in actors if o.type == 'ARMATURE')
        for o in actors:
            for mod in o.modifiers:
                if mod.type == 'ARMATURE':
                    mod.use_deform_preserve_volume = False
        clock = seconds * manifest['fps']
        scene.frame_set(math.floor(clock), subframe=clock-math.floor(clock))
        bpy.context.view_layer.update()
        basis = {o:o.matrix_basis.copy() for o in actors}
        bone_basis = {b.name:b.matrix_basis.copy() for b in rig.pose.bones}
        for o in actors:
            o.animation_data_clear()
            o.matrix_basis = basis[o]
        for name, matrix in bone_basis.items():
            rig.pose.bones[name].matrix_basis = matrix
        bpy.context.view_layer.update()
        before = minima(skin(rig))
        placement_fit=None
        phase_pitch_delta=top_pitch_delta_deg if phase=='pressed-top' else 0.0
        if phase=='pressed-top' and fit_top_placement:
            phase_pitch_delta,placement_fit=fitted_top_placement(rig,targets)
        if phase == 'pressed-top' and phase_pitch_delta:
            pivot=(world(rig,'L_ToeBase').translation+world(rig,'R_ToeBase').translation)/2
            rotation=Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(phase_pitch_delta),4,'X') @ Matrix.Translation(-pivot)
            for o in actors:
                if o.parent is None:
                    o.matrix_world=rotation @ o.matrix_world
            bpy.context.view_layer.update()
            before=minima(skin(rig))
        support_min = min(value for key,value in before.items() if key.endswith((' foot', ' toes')))
        lift = -support_min
        transform = Matrix.Translation(Vector((0,0,lift)))
        for o in actors:
            if o.parent is None:
                o.matrix_world = transform @ o.matrix_world
        bpy.context.view_layer.update()
        after_root = minima(skin(rig))
        arms = [solve_arm(rig, side, targets[side][0]) for side in ['L', 'R']]
        after = minima(skin(rig))
        leg_names = [b.name for b in rig.pose.bones if any(x in b.name for x in ['Hip','Thigh','Calf','Foot','Toe','Knee'])]
        leg_delta = max(bone_basis[name].to_quaternion().rotation_difference(rig.pose.bones[name].matrix_basis.to_quaternion()).angle for name in leg_names)
        positions = {b.name:ep(rig.matrix_world @ b.matrix.translation) for b in rig.pose.bones}
        row = {'id':case['variant']+'-'+phase,'phase':phase,'sourceTimeSec':seconds,
               'sourceModelSha256':case['sourceModelSha256'],'rootLiftM':lift,
               'beforeSkinMinimaWorldY':before,'afterRootSkinMinimaWorldY':after_root,
               'afterSkinMinimaWorldY':after,'arms':arms,
               'fixedPalmTargets':{side:value[1] for side,value in targets.items()},
               'sharedLongitudinalRetreatM':fixed_retreat,'layoutFitEndpointBounds':layout_rows,
               'topPitchDeltaDeg':phase_pitch_delta,'topPlacementFit':placement_fit,
               'lowerChainLocalRotationMaxDeltaDeg':math.degrees(leg_delta),
               'allBonePositionsEngineM':positions,'boneCount':len(positions),
               'clinicalStatus':'Unqualified geometric arm proposal; transfer must preserve measured clinical/patient caps through existing bounded contact controller.'}
        report['cases'].append(row)
        bpy.ops.mesh.primitive_plane_add(size=20,location=(0,0,0))
        bpy.context.object.name='Explicit world-zero support plane'
        bpy.context.object.data.materials.append(floor_material)
        scene.render.engine='BLENDER_WORKBENCH'
        scene.render.resolution_x,scene.render.resolution_y,scene.render.resolution_percentage=900,650,100
        scene.display.shading.color_type='MATERIAL'
        scene.display.shading.show_shadows=True
        scene.display.shading.show_cavity=True
        scene.display.shading.background_type='WORLD'
        scene.world=bpy.data.worlds.new(row['id']+' world')
        scene.world.color=(.12,.14,.16)
        points=[Vector((p[0],-p[2],p[1])) for p in positions.values()]
        low=Vector(tuple(min(p[i] for p in points) for i in range(3)))
        high=Vector(tuple(max(p[i] for p in points) for i in range(3)))
        center=(low+high)/2
        for view,offset in [('Side',(1,-.15,.3)),('Overhead',(0,-.01,1))]:
            camera=bpy.data.objects.new(view+' camera',bpy.data.cameras.new(view))
            scene.collection.objects.link(camera)
            camera.location=center+Vector(offset)*3
            camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
            camera.data.type,camera.data.ortho_scale='ORTHO',2.15
            scene.camera=camera
            scene.render.filepath=str(output/(row['id']+'-'+view.lower()+'.png'))
            bpy.ops.render.render(write_still=True)
        scene.camera=next(o for o in scene.objects if o.type=='CAMERA' and o.name.startswith('Side'))
        print('PLANK_SUPPORT_PROPOSAL',json.dumps({k:row[k] for k in ['id','rootLiftM','beforeSkinMinimaWorldY','afterSkinMinimaWorldY','arms','lowerChainLocalRotationMaxDeltaDeg']}),flush=True)
text=bpy.data.texts.new('START HERE - toe and palm skin authoring')
text.write(report['scope']+'\nOriginal Review scenes retain the full unchanged timeline. Author toe-palm scenes are static endpoint proposals with editable palm and elbow controls. JSON reports all101bone positions and complete skin region minima. Only bounded runtime transfer and fresh full-cycle evidence can qualify these geometric targets.\n')
bpy.ops.wm.save_as_mainfile(filepath=str(output/'plank-skin-support-proposal.blend'))
(output/'proposal.json').write_text(json.dumps(report,indent=2)+'\n')
if sha(source/'full-motion-review.blend')!=report['sourceProjectSha256']:
    raise RuntimeError('Source project changed')
