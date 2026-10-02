"""Measure every rendered vertex against the engine floor over a saved animation.

Blender --background --python measure-floor-clearance.py -- <review-folder>
This is geometric evidence, not a pressure/compression or clinical qualification.
"""
import bpy
import json
import math
import sys
from pathlib import Path
import numpy as np

args = sys.argv[sys.argv.index('--') + 1:]
folder = Path(args[0]).resolve()
output = folder / (args[1] if len(args) > 1 else 'skin-floor-clearance.json')
if output.exists():
    raise RuntimeError('Preserve the previous measurements; use a fresh review folder')
manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8-sig'))
bpy.ops.wm.open_mainfile(filepath=str(folder / 'full-motion-review.blend'))
report = {'sourceDigest': manifest['sourceDigest'], 'fps': manifest['fps'],
          'scope': 'Every evaluated skin vertex at every exported sample. Regions use the dominant skin-weight bone. No force or clinical acceptance.',
          'cases': []}

def region(name):
    side = 'L' if '_L_' in name else 'R' if '_R_' in name else 'center'
    # Toe names also include Index/Mid/Ring/Pinky. Classify feet first.
    if 'Toe' in name:
        return side + ' toes'
    if any(part in name for part in ['Hand', 'Thumb', 'Index', 'Mid', 'Ring', 'Pinky']):
        return side + ' palm/fingers'
    for part, label in [('Forearm', 'forearm'), ('Upperarm', 'upper arm'), ('UpperArm', 'upper arm'),
                        ('Shoulder', 'shoulder'), ('Toe', 'toes'), ('Foot', 'foot'),
                        ('Thigh', 'thigh'), ('Calf', 'calf'), ('Head', 'head'), ('Neck', 'neck')]:
        if part in name:
            return side + ' ' + label
    return 'torso/other'

for case in manifest['cases']:
    scene = bpy.data.scenes['Review ' + case['id']]
    bpy.context.window.scene = scene
    meshes = []
    for obj in scene.objects:
        if obj.type != 'MESH' or not any(mod.type == 'ARMATURE' for mod in obj.modifiers):
            continue
        groups = {group.index: region(group.name) for group in obj.vertex_groups}
        labels = [groups[max(vertex.groups, key=lambda item: item.weight).group] if vertex.groups else 'unweighted'
                  for vertex in obj.data.vertices]
        meshes.append((obj, {label: np.array([i for i, value in enumerate(labels) if value == label], dtype=np.int32)
                             for label in set(labels)}))
    if not meshes:
        raise RuntimeError('No evaluated skin meshes in ' + case['id'])
    frames, worst = [], {}
    for index in range(case['frames']):
        seconds = min(index / manifest['fps'], case['durationMs'] / 1000)
        frame = seconds * manifest['fps']
        scene.frame_set(math.floor(frame), subframe=frame - math.floor(frame))
        graph = bpy.context.evaluated_depsgraph_get()
        minima = {}
        for obj, regions in meshes:
            evaluated = obj.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            if len(mesh.vertices) != len(obj.data.vertices):
                raise RuntimeError('Topology changed; vertex region mapping is invalid')
            coords = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
            mesh.vertices.foreach_get('co', coords)
            matrix = np.array(evaluated.matrix_world)
            heights = coords.reshape((-1, 3)) @ matrix[2, :3] + matrix[2, 3] - case['floorY']
            for label, indices in regions.items():
                height = float(heights[indices].min())
                minima[label] = min(minima.get(label, float('inf')), height)
            evaluated.to_mesh_clear()
        frames.append({'timeSec': seconds, 'minimumClearanceM': minima})
        for label, height in minima.items():
            if label not in worst or height < worst[label]['clearanceM']:
                worst[label] = {'timeSec': seconds, 'clearanceM': height}
    row = {'id': case['id'], 'floorY': case['floorY'], 'worst': worst, 'frames': frames}
    report['cases'].append(row)
    print('SKIN_FLOOR', json.dumps({'id': case['id'], 'worst': worst}), flush=True)
output.write_text(json.dumps(report, indent=2) + '\n')
