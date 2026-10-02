"""Advance planted trunk-push-up palms in an editable Blender authoring project."""
import bpy
import json
import sys
from pathlib import Path

args = sys.argv[sys.argv.index('--') + 1:]
source, output = Path(args[0]).resolve(), Path(args[1]).resolve()
output.mkdir()
bpy.ops.wm.open_mainfile(filepath=str(source / 'floor-support.blend'))
rows = []
for scene in bpy.data.scenes:
    if 'trunk-stability-push-up' not in scene.name:
        continue
    bpy.context.window.scene = scene
    for obj in scene.objects:
        if 'palm anchor' in obj.name:
            before = list(obj.location)
            obj.location.y -= .04  # Blender -Y is engine forward.
            rows.append({'scene': scene.name, 'control': obj.name, 'beforeBlenderM': before, 'afterBlenderM': list(obj.location)})
    bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=str(output / 'floor-support.blend'))
(output / 'authored-palm-advance.json').write_text(json.dumps({'source': str(source), 'forwardChangeM': .04, 'controls': rows}, indent=2))
