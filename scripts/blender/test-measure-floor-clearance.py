"""Integration regression for floor diagnostic observations, using synthetic skin.

Blender --background --factory-startup --python-exit-code 1 --python
  scripts/blender/test-measure-floor-clearance.py -- <fresh-test-folder>
This fixture is a measurement test, not a human movement or body asset.
"""
import bpy
import contextlib
import hashlib
import io
import json
import math
from pathlib import Path
import runpy
import sys

folder = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
folder.mkdir()  # Preserve each test run and its generated evidence.
script = Path(__file__).with_name('measure-floor-clearance.py')
cases = []
for case_id in ['synthetic-a', 'synthetic-b']:
    scene = bpy.data.scenes.new('Review ' + case_id)
    bpy.context.window.scene = scene
    scene.render.fps = 2
    rig = bpy.data.objects.new(case_id + '-rig', bpy.data.armatures.new(case_id + '-armature'))
    scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bone_name = 'CC_Base_L_BigToe1'
    bone = rig.data.edit_bones.new(bone_name)
    bone.head, bone.tail = (0, 0, 0), (0, 0, 1)
    bpy.ops.object.mode_set(mode='OBJECT')
    mesh = bpy.data.meshes.new(case_id + '-geometry')
    mesh.from_pydata([(0, 0, 0), (1, 0, .2), (0, 1, .3)], [], [(0, 1, 2)])
    obj = bpy.data.objects.new(case_id + '-skin', mesh)
    scene.collection.objects.link(obj)
    obj.vertex_groups.new(name=bone_name).add([0, 1, 2], 1.0, 'REPLACE')
    obj.modifiers.new('Skin', 'ARMATURE').object = rig
    obj.rotation_euler.z = math.pi / 2
    obj.location = (3, 4, 1)
    obj.keyframe_insert(data_path='location', frame=0)
    obj.location.z = 0
    obj.keyframe_insert(data_path='location', frame=1)
    obj.location.z = -1
    obj.keyframe_insert(data_path='location', frame=2)
    # The inspector checks the declared source hash. No GLB import is needed
    # because this deliberately small scene is the synthetic evaluated fixture.
    source = (case_id + ' synthetic source identity').encode()
    (folder / (case_id + '.glb')).write_bytes(source)
    cases.append({'id': case_id, 'variant': 'synthetic', 'movement': 'measurement-test',
                  'side': 'L', 'frames': 3, 'durationMs': 1000, 'floorY': .25,
                  'file': case_id + '.glb', 'glbSha256': hashlib.sha256(source).hexdigest(),
                  'sourceModelSha256': hashlib.sha256(b'synthetic fixture').hexdigest()})
manifest = {'fps': 2, 'sourceDigest': 'synthetic-fixture', 'sourceRevision': None, 'cases': cases}
(folder / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
bpy.ops.wm.save_as_mainfile(filepath=str(folder / 'full-motion-review.blend'))

def run(*args):
    previous = sys.argv
    try:
        sys.argv = ['blender', '--', str(folder), *args]
        runpy.run_path(str(script), run_name='__main__')
    finally:
        sys.argv = previous

def rejected(args, error_type):
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            run(*args)
    except error_type as error:
        if isinstance(error, SystemExit):
            assert error.code == 2
        return
    raise AssertionError('Expected rejection: ' + repr(args))

run('single.json', '--comparison-floor-y', '0', '--comparison-label', 'explicit-zero', '--case', 'synthetic-b')
report = json.loads((folder / 'single.json').read_text())
assert len(report['cases']) == 1 and report['cases'][0]['id'] == 'synthetic-b'
case = report['cases'][0]
assert [sample['minimumClearanceM']['L toes'] for sample in case['frames']] == [.75, -.25, -1.25]
engine, zero = case['planes']
first = engine['firstGeometricCrossing']
assert first['timeSec'] == .5 and first['sampleIndex'] == 1
assert first['timeBracketSec'] == [0, .5]
assert first['pair'] == {'region': 'L toes', 'plane': 'engine-reference'}
assert first['witness'] == {'mesh': 'synthetic-b-skin', 'vertexIndex': 0,
                            'dominantWeightBone': 'CC_Base_L_BigToe1', 'enginePositionM': [3.0, 0.0, -4.0]}
assert first['phase'] == 'unknown' and report['phaseMetadata']['status'] == 'unknown'
assert zero['firstGeometricCrossing']['timeSec'] == 1  # At .5 the skin is exactly on the plane.
assert zero['firstGeometricCrossing']['timeBracketSec'] == [.5, 1]
assert zero['regions']['L toes']['worst']['witness']['enginePositionM'] == [3.0, -1.0, -4.0]
assert len(report['provenance']['projectSha256']) == 64 and report['blenderVersion'] == bpy.app.version_string

run('initial.json', '--comparison-floor-y', '2', '--comparison-label', 'explicit-high')
initial = json.loads((folder / 'initial.json').read_text())
assert len(initial['cases']) == 2
for row in initial['cases']:
    crossing = row['planes'][1]['firstGeometricCrossing']
    assert crossing['observation'] == 'initial-sample-below-plane'
    assert crossing['timeBracketSec'] == [0, 0] and crossing['sampleIndex'] == 0

original = (folder / 'single.json').read_bytes()
rejected(['single.json'], RuntimeError)
assert (folder / 'single.json').read_bytes() == original
rejected(['incomplete.json', '--comparison-floor-y', '0'], SystemExit)
rejected(['nan.json', '--comparison-floor-y', 'nan', '--comparison-label', 'bad'], SystemExit)
rejected(['unknown.json', '--case', 'missing'], SystemExit)
(folder / cases[0]['file']).write_bytes(b'changed source')
rejected(['tampered.json'], RuntimeError)
assert not any((folder / name).exists() for name in ['incomplete.json', 'nan.json', 'unknown.json', 'tampered.json'])
print('FLOOR_DIAGNOSTIC_REGRESSION_PASS: transformed witnesses, strict-zero crossing, time brackets, initial penetration, case selection, provenance, argument/source/overwrite guards')
