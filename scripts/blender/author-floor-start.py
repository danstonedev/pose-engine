"""Author floor assessment clips that begin in their prepared support pose.
Blender --background --python author-floor-start.py -- <review-folder> <new-folder>
"""
import bpy
import json
import sys
from pathlib import Path

source, output = map(Path, sys.argv[sys.argv.index('--') + 1:])
output.mkdir()
manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8-sig'))
bpy.ops.wm.open_mainfile(filepath=str(source / 'full-motion-review.blend'))
report = {'sourceDigest': manifest['sourceDigest'], 'intent': 'Self-contained assessments begin in the prepared floor posture. Floor transfers remain separate movements.', 'scenes': []}
for case in manifest['cases']:
    if case['movement'] not in ['trunk-stability-push-up', 'extension-clearing', 'flexion-clearing']:
        continue
    scene = bpy.data.scenes['Review ' + case['id']]
    actions = {obj.animation_data.action for obj in scene.objects if obj.animation_data and obj.animation_data.action}
    for action in actions:
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for curve in bag.fcurves:
                        setup = curve.evaluate(case['setupFrame'])
                        for key in curve.keyframe_points:
                            if key.co.x <= case['setupFrame']:
                                key.co.y = key.handle_left.y = key.handle_right.y = setup
                        curve.update()
    scene.frame_set(0)
    scene['start_at_setup'] = True
    report['scenes'].append(scene.name)
if len(report['scenes']) != 9:
    raise RuntimeError('Expected three floor assessments on each production body')
bpy.ops.wm.save_as_mainfile(filepath=str(output / 'floor-assessment-start.blend'))
(output / 'authored-start.json').write_text(json.dumps(report, indent=2) + '\n')
