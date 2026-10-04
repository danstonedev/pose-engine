"""Measure animated skin against explicit horizontal planes, without moving it.

Blender --background --python measure-floor-clearance.py -- <review-folder>
  [fresh-output.json] [--comparison-floor-y 0 --comparison-label "world-zero"]
  [--case male-flexion-clearing --case female-flexion-clearing]
Engine coordinates are metres, Y up. A comparison plane has no implicit authority.
This is sampled geometry, not pressure/compression or clinical qualification.
"""
import argparse
import bpy
import hashlib
import json
import math
import sys
from pathlib import Path
import numpy as np

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('review_folder')
parser.add_argument('output', nargs='?', default='skin-floor-clearance.json')
parser.add_argument('--comparison-floor-y', type=float)
parser.add_argument('--comparison-label')
parser.add_argument('--case', action='append', dest='case_ids')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
if (args.comparison_floor_y is None) != (args.comparison_label is None):
    parser.error('--comparison-floor-y and --comparison-label must be supplied together')
if args.comparison_floor_y is not None and (not math.isfinite(args.comparison_floor_y)
        or not args.comparison_label.strip() or args.comparison_label == 'engine-reference'):
    parser.error('Comparison requires a finite height and a nonempty label other than engine-reference')
folder = Path(args.review_folder).resolve()
output = folder / args.output
if output.exists():
    raise RuntimeError('Preserve previous measurements; choose a fresh output filename')
manifest_path = folder / 'manifest.json'
project_path = folder / 'full-motion-review.blend'
manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
cases = manifest['cases']
if args.case_ids:
    unknown = set(args.case_ids) - {case['id'] for case in cases}
    if unknown:
        parser.error('Unknown case IDs: ' + ', '.join(sorted(unknown)))
    cases = [case for case in cases if case['id'] in args.case_ids]
if not cases or not math.isfinite(manifest['fps']) or manifest['fps'] <= 0:
    raise RuntimeError('At least one case and a positive finite sample rate are required')

def sha256(path):
    with path.open('rb') as source:
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
        return digest.hexdigest()

phase = {'status': 'unknown', 'reason': 'The export manifest has no authoritative motion phase intervals. setupFrame and holdFrame are review markers, not phase boundaries.'}
report = {'schemaVersion': 2, 'sourceDigest': manifest['sourceDigest'], 'fps': manifest['fps'],
          'sourceRevision': manifest.get('sourceRevision'), 'sourceStatus': manifest.get('sourceStatus'),
          'blenderVersion': bpy.app.version_string,
          'blenderBuildHash': bpy.app.build_hash.decode('utf-8', errors='replace'),
          'provenance': {'scriptSha256': sha256(Path(__file__)), 'manifestSha256': sha256(manifest_path),
                         'projectSha256': sha256(project_path), 'project': str(project_path),
                         'arguments': sys.argv[sys.argv.index('--') + 1:]},
          'scope': 'Every evaluated skin vertex at every exported sample. Regions use the dominant skin-weight bone. Crossing means clearance below 0 metres, not a contact acceptance gate. Between-sample geometry, forces, compression and clinical acceptance are not evaluated.',
          'coordinates': 'Engine X left, Y up, Z anterior; metres. Blender world (x,y,z) maps to engine (x,z,-y).',
          'phaseMetadata': phase,
          'cases': []}
bpy.ops.wm.open_mainfile(filepath=str(project_path))

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

for case in cases:
    if not math.isfinite(case['floorY']) or case['frames'] <= 0:
        raise RuntimeError('Finite engine reference and nonempty samples required for ' + case['id'])
    sample_times = case.get('sampleTimesSec')
    if sample_times is not None and (len(sample_times) != case['frames']
            or any(not math.isfinite(t) or t < 0 or t > case['durationMs'] / 1000 + 1e-8 for t in sample_times)
            or any(b <= a for a, b in zip(sample_times, sample_times[1:]))):
        raise RuntimeError('Exact retained sample clocks are invalid for ' + case['id'])
    glb_digest = sha256(folder / case['file'])
    if glb_digest != case['glbSha256']:
        raise RuntimeError('Source GLB no longer matches the manifest: ' + case['id'])
    scene = bpy.data.scenes['Review ' + case['id']]
    bpy.context.window.scene = scene
    meshes = []
    for obj in scene.objects:
        if obj.type != 'MESH' or not any(mod.type == 'ARMATURE' for mod in obj.modifiers):
            continue
        groups = {group.index: group.name for group in obj.vertex_groups}
        bones = [groups[max(vertex.groups, key=lambda item: item.weight).group] if vertex.groups else None
                 for vertex in obj.data.vertices]
        labels = [region(bone) if bone else 'unweighted' for bone in bones]
        meshes.append((obj, bones, {label: np.array([i for i, value in enumerate(labels) if value == label], dtype=np.int32)
                                    for label in sorted(set(labels))}))
    if not meshes:
        raise RuntimeError('No evaluated skin meshes in ' + case['id'])
    planes = [{'label': 'engine-reference', 'floorY': case['floorY'],
               'semantics': ('Explicit authored world-Y support plane.' if 'supportPlaneY' in case else
                             'Exported rest-bone reference. This is not a measured supporting skin surface.'),
               'regions': {}, 'firstGeometricCrossing': None}]
    if args.comparison_floor_y is not None:
        planes.append({'label': args.comparison_label, 'floorY': args.comparison_floor_y,
                       'semantics': 'Explicit caller-supplied comparison plane. Agreement with a host or native floor must be established separately.',
                       'regions': {}, 'firstGeometricCrossing': None})
    frames, worst = [], {}
    previous_seconds = None
    for index in range(case['frames']):
        seconds = sample_times[index] if sample_times is not None else min(index / manifest['fps'], case['durationMs'] / 1000)
        frame = seconds * manifest['fps']
        scene.frame_set(math.floor(frame), subframe=frame - math.floor(frame))
        graph = bpy.context.evaluated_depsgraph_get()
        minima, witnesses = {}, {}
        for obj, bones, regions in meshes:
            evaluated = obj.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            if len(mesh.vertices) != len(obj.data.vertices):
                raise RuntimeError('Topology changed; vertex region mapping is invalid')
            coords = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
            mesh.vertices.foreach_get('co', coords)
            matrix = np.array(evaluated.matrix_world)
            local_positions = coords.reshape((-1, 3))
            heights = local_positions @ matrix[2, :3] + matrix[2, 3] - case['floorY']
            if not np.isfinite(heights).all():
                raise RuntimeError('Nonfinite evaluated skin heights in ' + case['id'])
            for label, indices in regions.items():
                vertex_index = int(indices[np.argmin(heights[indices])])
                height = float(heights[vertex_index])
                if height < minima.get(label, float('inf')):
                    minima[label] = height
                    world = matrix[:3, :3] @ local_positions[vertex_index] + matrix[:3, 3]
                    witnesses[label] = {'mesh': obj.name, 'vertexIndex': vertex_index,
                                        'dominantWeightBone': bones[vertex_index],
                                        'enginePositionM': [float(world[0]), float(world[2]), float(-world[1])]}
            evaluated.to_mesh_clear()
        frames.append({'timeSec': seconds, 'minimumClearanceM': minima})
        for label, height in minima.items():
            if label not in worst or height < worst[label]['clearanceM']:
                worst[label] = {'timeSec': seconds, 'clearanceM': height}
            for plane in planes:
                clearance = height + (case['floorY'] - plane['floorY'])
                event = {'timeSec': seconds, 'sampleIndex': index, 'clearanceM': clearance,
                         'pair': {'region': label, 'plane': plane['label']}, 'phase': 'unknown',
                         'witness': witnesses[label]}
                summary = plane['regions'].setdefault(label, {'worst': event, 'firstGeometricCrossing': None})
                if clearance < summary['worst']['clearanceM']:
                    summary['worst'] = event
                if clearance < 0 and summary['firstGeometricCrossing'] is None:
                    crossing = {**event, 'timeBracketSec': [previous_seconds if previous_seconds is not None else seconds, seconds],
                                'observation': 'initial-sample-below-plane' if index == 0 else 'first-sampled-below-plane'}
                    summary['firstGeometricCrossing'] = crossing
                    if plane['firstGeometricCrossing'] is None:
                        plane['firstGeometricCrossing'] = crossing
        previous_seconds = seconds
    row = {'id': case['id'], 'variant': case.get('variant'), 'movement': case.get('movement'), 'side': case.get('side'),
           'floorY': case['floorY'], 'sourceModelSha256': case['sourceModelSha256'], 'glbSha256': glb_digest,
           'worst': worst, 'frames': frames, 'planes': planes}
    if 'supportPlaneY' in case:
        row.update({'supportPlaneY': case['supportPlaneY'], 'restContactFloorY': case.get('restContactFloorY')})
    report['cases'].append(row)
    print('SKIN_FLOOR', json.dumps({'id': case['id'], 'worst': worst}), flush=True)
with output.open('x', encoding='utf-8') as target:
    target.write(json.dumps(report, indent=2, allow_nan=False) + '\n')
