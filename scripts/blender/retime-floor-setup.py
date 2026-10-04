"""Author a one-second push-up approach on the imported production animation.
Blender --background --python retime-floor-setup.py -- <source.blend> <new-folder>
"""
import bpy
import json
import sys
from pathlib import Path

source, destination = map(Path, sys.argv[sys.argv.index('--') + 1:])
destination.mkdir()
bpy.ops.wm.open_mainfile(filepath=str(source))
report = {'source': str(source), 'setupFromMs': 350, 'setupToMs': 1000, 'scenes': []}
for scene in bpy.data.scenes:
    if not scene.name.endswith('-push-up') or 'trunk' in scene.name:
        continue
    old_end, new_end = .35 * scene.render.fps, scene.render.fps
    actions = {obj.animation_data.action for obj in scene.objects if obj.animation_data and obj.animation_data.action}
    for action in actions:
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for curve in bag.fcurves:
                        for key in curve.keyframe_points:
                            for point in [key.co, key.handle_left, key.handle_right]:
                                point.x = point.x * new_end / old_end if point.x <= old_end else point.x + new_end - old_end
                        curve.update()
    for marker in scene.timeline_markers:
        marker.frame = round(marker.frame * new_end / old_end if marker.frame <= old_end else marker.frame + new_end - old_end)
    scene.frame_end += round(new_end - old_end)
    scene['authored_setup_ms'] = 1000
    report['scenes'].append(scene.name)
if len(report['scenes']) != 3:
    raise RuntimeError('Expected one push-up scene per production body')
bpy.ops.wm.save_as_mainfile(filepath=str(destination / 'floor-support-timing.blend'))
(destination / 'authored-timing.json').write_text(json.dumps(report, indent=2) + '\n')
