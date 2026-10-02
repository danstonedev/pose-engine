"""Keep trunk-push-up elbow guides closer to the body in an editable candidate."""
import bpy
import json
import sys
from pathlib import Path

source, output = [Path(arg).resolve() for arg in sys.argv[sys.argv.index('--') + 1:]]
output.mkdir()
bpy.ops.wm.open_mainfile(filepath=str(source / 'floor-support.blend'))
rows = []
for scene in bpy.data.scenes:
    if 'trunk-stability-push-up' not in scene.name:
        continue
    bpy.context.window.scene = scene
    for obj in scene.objects:
        if 'elbow guide' not in obj.name:
            continue
        before = list(obj.location)
        obj.location.x -= .04 if obj.name.startswith('L ') else -.04
        rows.append({'scene': scene.name, 'control': obj.name,
                     'beforeBlenderM': before, 'afterBlenderM': list(obj.location)})
    bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=str(output / 'floor-support.blend'))
(output / 'authored-elbow-guides.json').write_text(json.dumps({
    'source': str(source), 'outwardM': .12, 'controls': rows,
    'scope': 'Candidate elbow directions. Full engine bounds and cycle review still required.'
}, indent=2) + '\n')
