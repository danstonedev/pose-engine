"""Build editable palm anchors and elbow guides on actual imported floor clips.
Blender --background --factory-startup --python build-floor-support.py -- <folder>
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector, Quaternion

folder = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
manifest = json.loads((folder / 'manifest.json').read_text())
project = folder / 'floor-support.blend'
if project.exists():
    raise RuntimeError('Use a fresh folder; previous authoring is preserved')
report = {'blenderVersion': bpy.app.version_string, 'sourceDigest': manifest['sourceDigest'],
          'scope': 'Visual authoring with fixed palms and explicit elbow poles; engine ROM validation required.', 'cases': []}

def bp(p):
    return Vector((p[0], -p[2], p[1]))

def ep(p):
    return [p.x, p.z, -p.y]

def presentation(scene):
    scene.world = bpy.data.worlds.new(scene.name + ' world')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.14, .18, .21, 1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .5
    bpy.ops.mesh.primitive_plane_add(size=10, location=(0, 0, -.025))
    floor = bpy.context.object
    floor.name = 'Floor reference'
    material = bpy.data.materials.new('Floor')
    material.diffuse_color = (.1, .14, .16, 1)
    floor.data.materials.append(material)
    camera = bpy.data.objects.new(scene.name + ' camera', bpy.data.cameras.new('Side review'))
    scene.collection.objects.link(camera)
    camera.location = (2.8, -1.5, 1.2)
    camera.rotation_euler = (bp((0, .3, 1.05)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 2.15
    scene.camera = camera
    for location, energy in [((3, -3, 4), 450), ((-3, -1, 3), 250)]:
        light = bpy.data.objects.new('Softbox', bpy.data.lights.new('Softbox', 'AREA'))
        light.data.energy, light.data.shape, light.data.size = energy, 'DISK', 4
        scene.collection.objects.link(light)
        light.location = location
        light.rotation_euler = (bp((0, .3, 1)) - light.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 12
    scene.render.resolution_x, scene.render.resolution_y = 1100, 750
    scene.render.resolution_percentage = 100

for case in manifest['cases']:
    # All three models are imported; each has its own actual segment lengths.
    scene = bpy.data.scenes.new('Author ' + case['id'])
    bpy.context.window.scene = scene
    scene.render.fps = manifest['fps']
    bpy.ops.import_scene.gltf(filepath=str(folder / case['file']), bone_heuristic='BLENDER', guess_original_bind_pose=True)
    rig = next(obj for obj in scene.objects if obj.type == 'ARMATURE')
    scene.frame_set(case['holdFrame'] - 1)
    bpy.context.view_layer.update()
    object_locals = {obj: obj.matrix_basis.copy() for obj in scene.objects}
    bone_locals = {bone.name: bone.matrix_basis.copy() for bone in rig.pose.bones}
    for obj in scene.objects:
        obj.animation_data_clear()
    scene.frame_set(0)
    for obj, matrix in object_locals.items():
        obj.matrix_basis = matrix
    for name, matrix in bone_locals.items():
        rig.pose.bones[name].matrix_basis = matrix
    bpy.context.view_layer.update()
    expected = json.loads((folder / case['expected']).read_text())['expected']
    setup = min(expected, key=lambda frame: abs(frame['frame'] - 1 - case['setupFrame']))['bones']
    result = {'id': case['id'], 'arms': {}}
    for side, sign in [('L', 1), ('R', -1)]:
        names = ['CC_Base_' + side + '_' + part for part in ['Upperarm', 'Forearm', 'Hand']]
        originals = [rig.matrix_world @ rig.pose.bones[name].matrix for name in names]
        points = [matrix.translation.copy() for matrix in originals]
        upper_length, lower_length = (points[1] - points[0]).length, (points[2] - points[1]).length
        setup_shoulder = setup[names[0]]
        wrist = bp((sign * (abs(setup_shoulder[0]) + .065), .02, setup_shoulder[2] + (.14 if case['movement'] == 'flexion-clearing' else .075 if case['movement'] == 'extension-clearing' else .035)))
        if case['movement'] == 'trunk-stability-push-up':
            wrist = bp((sign * (abs(setup_shoulder[0]) + .065), .02, setup_shoulder[2] + .16))
        # Keep the authored target inside the measured reach sphere.
        reach = wrist - points[0]
        if reach.length > .985 * (upper_length + lower_length):
            wrist = points[0] + reach.normalized() * .985 * (upper_length + lower_length)
        pole_point = points[0] + bp((sign * .16, -.05, -.4))
        goal = bpy.data.objects.new(side + ' palm anchor', None)
        goal.empty_display_type, goal.empty_display_size = 'ARROWS', .065
        goal.location = wrist
        scene.collection.objects.link(goal)
        pole = bpy.data.objects.new(side + ' elbow guide', None)
        pole.empty_display_type, pole.empty_display_size = 'SPHERE', .035
        pole.location = pole_point
        scene.collection.objects.link(pole)
        data = bpy.data.armatures.new(side + ' contact controls')
        controls = bpy.data.objects.new(data.name, data)
        scene.collection.objects.link(controls)
        controls.show_in_front = True
        bpy.ops.object.select_all(action='DESELECT')
        controls.select_set(True)
        bpy.context.view_layer.objects.active = controls
        bpy.ops.object.mode_set(mode='EDIT')
        previous = None
        for index, name in enumerate(['Upper arm', 'Forearm']):
            bone = data.edit_bones.new(name)
            bone.head, bone.tail = points[index], points[index + 1]
            bone.use_deform = False
            if previous:
                bone.parent, bone.use_connect = previous, True
            previous = bone
        bpy.ops.object.mode_set(mode='OBJECT')
        for bone in controls.pose.bones:
            bone.ik_stretch = 0
        # Bind source coordinate offsets before enabling IK.
        for index, control_name in enumerate(['Upper arm', 'Forearm']):
            offset = bpy.data.objects.new(side + ' source frame ' + control_name, None)
            scene.collection.objects.link(offset)
            offset.parent, offset.parent_type, offset.parent_bone = controls, 'BONE', control_name
            bpy.context.view_layer.update()
            offset.matrix_world = originals[index]
            offset.hide_set(True)
            copy = rig.pose.bones[names[index]].constraints.new('COPY_ROTATION')
            copy.target, copy.owner_space, copy.target_space = offset, 'WORLD', 'WORLD'
        ik = controls.pose.bones['Forearm'].constraints.new('IK')
        ik.target, ik.pole_target, ik.chain_count = goal, pole, 2
        ik.use_stretch, ik.iterations = False, 128
        direction = (wrist - points[0]).normalized()
        preferred = (pole_point - points[0]) - direction * (pole_point - points[0]).dot(direction)
        preferred.normalize()
        best = (float('inf'), 0)
        for step in range(64):
            angle = -math.pi + step * 2 * math.pi / 64
            ik.pole_angle = angle
            bpy.context.view_layer.update()
            elbow = controls.matrix_world @ controls.pose.bones['Forearm'].head
            perpendicular = elbow - points[0] - direction * (elbow - points[0]).dot(direction)
            error = (perpendicular.normalized() - preferred).length
            if error < best[0]:
                best = (error, angle)
        ik.pole_angle = best[1]
        bpy.context.view_layer.update()
        hand = rig.pose.bones[names[2]]
        world = rig.matrix_world @ hand.matrix
        middle = (rig.matrix_world @ rig.pose.bones['CC_Base_' + side + '_Mid1'].matrix).translation
        index = (rig.matrix_world @ rig.pose.bones['CC_Base_' + side + '_Index1'].matrix).translation
        pinky = (rig.matrix_world @ rig.pose.bones['CC_Base_' + side + '_Pinky1'].matrix).translation
        long = (middle - world.translation).normalized()
        normal = long.cross(index - pinky).normalized() * sign
        down = Vector((0, 0, -1))
        flatten = normal.rotation_difference(down)
        forward = flatten @ long
        forward.z = 0
        heading = forward.normalized().rotation_difference(Vector((0, -1, 0)))
        goal.rotation_mode = 'QUATERNION'
        goal.rotation_quaternion = heading @ flatten @ world.to_quaternion()
        copy = hand.constraints.new('COPY_ROTATION')
        copy.target, copy.owner_space, copy.target_space = goal, 'WORLD', 'WORLD'
        bpy.context.view_layer.update()
        result['arms'][side] = {'anchorM': ep(goal.location), 'elbowGuideM': ep(pole.location),
            'elbowM': ep(rig.matrix_world @ rig.pose.bones[names[1]].matrix.translation),
            'wristErrorM': ((rig.matrix_world @ hand.matrix.translation) - goal.location).length,
            'landmarks': {name: ep(rig.matrix_world @ rig.pose.bones[name].matrix.translation) for name in names}}
    presentation(scene)
    scene['instructions'] = 'Move palm anchors with G; move elbow guides to set the bend direction. No stretching. Exported engine clinical bounds must still pass.'
    report['cases'].append(result)
    if case['variant'] == 'male':
        scene.render.filepath = str(folder / (case['id'] + '-authored.png'))
        bpy.ops.render.render(write_still=True)

readme = bpy.data.texts.new('START HERE - planted floor supports')
readme.write('Each Author scene contains the actual skinned body and independent left/right palm anchors and elbow guides. G moves a control. IK stretching is disabled. These are candidate poses; check engine joint bounds and full motion before promotion. Source clips and measurements remain beside this project.\n')
bpy.context.window.scene = bpy.data.scenes['Author male-flexion-clearing']
bpy.ops.wm.save_as_mainfile(filepath=str(project))
(folder / 'authored-floor-targets.json').write_text(json.dumps(report, indent=2) + '\n')
print('FLOOR_AUTHORING_READY', str(project), flush=True)
