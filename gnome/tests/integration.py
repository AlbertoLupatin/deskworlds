#!/usr/bin/env python3
"""Optional Fedora/GNOME 50 integration test. All state is private under /tmp.

Run: python3 gnome/tests/integration.py
Requires a GPU, gnome-shell, gjs, gdbus and the wallpaper's host dependencies.
The test bridge permits Eval only in its separate headless GNOME process.
"""
import ast
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
UUID = 'deskworlds@deskworlds.local'

if '--inside' not in sys.argv:
    folder = Path(tempfile.mkdtemp(prefix='deskworlds-integration-'))
    env = os.environ.copy()
    for name, suffix in [('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'),
                         ('XDG_CACHE_HOME', 'cache'), ('XDG_RUNTIME_DIR', 'runtime')]:
        path = folder / suffix
        path.mkdir(mode=0o700)
        env[name] = str(path)
    env.update(DESKWORLDS_TEST_DIR=str(folder), XDG_DATA_DIRS='/usr/local/share:/usr/share',
               DESKWORLDS_DEBUG='1', GTK_A11Y='none', GDK_BACKEND='wayland')
    env.pop('DISPLAY', None)
    env.pop('WAYLAND_DISPLAY', None)
    print(f'Private test artifacts: {folder}', flush=True)
    sys.exit(subprocess.call(['dbus-run-session', '--', sys.executable, __file__, '--inside'], env=env))

folder = Path(os.environ['DESKWORLDS_TEST_DIR'])
assert all(Path(os.environ[name]).parent == folder for name in
           ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'])
extensions = folder / 'data/gnome-shell/extensions'
extensions.mkdir(parents=True)
(extensions / UUID).symlink_to(ROOT / 'gnome' / UUID)
bridge = extensions / 'dwtest@local'
bridge.mkdir()
(bridge / 'metadata.json').write_text(json.dumps({'uuid': 'dwtest@local', 'name': 'Private test bridge',
    'description': 'Headless integration tests only', 'shell-version': ['50']}))
(bridge / 'extension.js').write_text('export default class { enable() { global.context.unsafe_mode = true; } '
                                  'disable() { global.context.unsafe_mode = false; } }')
config = folder / 'config/deskworlds/wallpaper.json'
config.parent.mkdir()
def settings(**change):
    config.write_text(json.dumps({'root': str(ROOT), 'scene': 'riverscape', 'mode': 'live',
                                 'paused': False, **change}))
settings()
for key, value in [('enabled-extensions', "['dwtest@local','deskworlds@deskworlds.local']"),
                   ('welcome-dialog-last-shown-version', '999')]:
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', key, value], check=True)

os.environ['WAYLAND_DISPLAY'] = 'wayland-deskworlds-test'
log_path = folder / 'shell.log'
log = log_path.open('w')
shell = subprocess.Popen(['gnome-shell', '--headless', '--wayland', '--no-x11',
    '--wayland-display=wayland-deskworlds-test', '--virtual-monitor', '1536x960',
    '--virtual-monitor', '1920x1080', '--virtual-monitor', '1080x1920'],
    stdout=log, stderr=subprocess.STDOUT)

def evaluate(js):
    result = subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.gnome.Shell',
        '--object-path', '/org/gnome/Shell', '--method', 'org.gnome.Shell.Eval', js],
        text=True, capture_output=True, check=True, timeout=10).stdout
    if not result.startswith('(true,'): raise RuntimeError(result)
    _, payload = ast.literal_eval(result.replace('(true,', '(True,', 1))
    value = json.loads(payload)
    return json.loads(value) if isinstance(value, str) and value.startswith('{') else value

def extension(code):
    return evaluate(f"(()=>{{const e=Main.extensionManager.lookup('{UUID}').stateObj;{code}}})()")

def stats():
    return extension("return JSON.stringify({sent:e._sent,rates:e._rates,ready:e._ready,pollMs:e._pollMs,"
        "overview:Main.overview.visible,scans:globalThis.__dwScans,polls:globalThis.__dwPolls,"
        "source:e._rendererActor?.get_size(),monitors:Main.layoutManager.monitors,"
        "wallpapers:[...e._wallpapers].map(h=>({monitor:h.monitorIndex,size:h.get_size(),"
        "clone:h.get_first_child()?.get_size()})),tabs:global.display.get_tab_list(0,null).map(w=>w.title)});")

try:
    for i in range(120):
        if shell.poll() is not None: raise RuntimeError(log_path.read_text()[-4000:])
        if 'scene ready' in log_path.read_text(): break
        time.sleep(.5)
    else: raise RuntimeError('Renderer did not become ready: ' + log_path.read_text()[-4000:])
    evaluate('Main.layoutManager.modalDialogGroup.get_children().forEach(d=>d.close?d.close():d.destroy()); Main.overview.hide(); 1')
    time.sleep(4)
    state = stats()
    assert state['ready'] and len(state['monitors']) == 3
    assert not any(title.startswith('@deskworlds-renderer!') for title in state['tabs'])
    assert len(state['wallpapers']) == 3
    sw, sh = state['source']
    for wallpaper in state['wallpapers']:
        monitor = state['monitors'][wallpaper['monitor']]
        assert wallpaper['size'] == [monitor['width'], monitor['height']]
        cw, ch = wallpaper['clone']
        assert cw >= monitor['width'] - .01 and ch >= monitor['height'] - .01
        assert abs(cw / ch - sw / sh) < .001
    print('PASS: three monitor backgrounds, portrait crop and hidden renderer', flush=True)

    extension('globalThis.__dwScans=0; globalThis.__dwPolls=0; const scan=e._desktopWindows.bind(e),poll=e._poll.bind(e);'
        'e._desktopWindows=(...args)=>{__dwScans++;return scan(...args)};'
        'e._poll=(...args)=>{__dwPolls++;return poll(...args)};return 1;')
    time.sleep(6)
    state = stats()
    assert 8 <= state['scans'] <= 14
    print(f"PASS: {state['scans']} window scans in six seconds ({state['polls']} pointer polls)", flush=True)

    settings(maxFps=20)
    time.sleep(1)
    assert stats()['sent']['rate'] == 20
    settings()
    time.sleep(1)
    assert stats()['sent']['rate'] == 30
    print('PASS: live frame cap updates without restarting the renderer', flush=True)

    # Synthetic cursor samples exercise real Shell actor picking on each monitor.
    # Avoid headless virtual-input-device mapping, which can clamp to a monitor edge.
    extension('globalThis.__dwGetPointer=global.get_pointer.bind(global);return 1;')
    for index in range(3):
        extension(f'const m=Main.layoutManager.monitors[{index}];'
            'global.get_pointer=()=>[m.x+m.width/2,m.y+m.height/2,0];'
            'e._pointerSample=null;e._poll(true);return 1;')
        assert stats()['sent']['pointer'] == 'pointer 0.500000 0.500000'
    extension('global.get_pointer=__dwGetPointer;e._poll(true);return 1;')
    print('PASS: centered cursor samples route from every desktop', flush=True)

    extension('globalThis.__dwWindows=e._desktopWindows;const m=Main.layoutManager.primaryMonitor;'
        'e._desktopWindows=()=>[{get_frame_rect:()=>m}];e._poll(true);return 1;')
    assert stats()['rates'].count(0) == 1 and stats()['sent']['rate'] == 30
    extension('e._desktopWindows=()=>Main.layoutManager.monitors.map(m=>({get_frame_rect:()=>m}));e._poll(true);return 1;')
    assert stats()['sent']['rate'] == 0 and stats()['pollMs'] == 500
    time.sleep(3)
    print('PASS: primary coverage keeps secondary screens running; all-covered rate is zero', flush=True)
    extension('e._desktopWindows=__dwWindows;e._poll(true);return 1;')
    time.sleep(2)
    subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.gnome.Shell.Screenshot',
        '--object-path', '/org/gnome/Shell/Screenshot', '--method',
        'org.gnome.Shell.Screenshot.Screenshot', 'false', 'false', str(folder / 'desktop.png')],
        check=True, capture_output=True)
    settings(paused=True)
    time.sleep(1)
    assert stats()['sent']['rate'] == 0
    settings(paused=False)
    time.sleep(1)
    assert stats()['sent']['rate'] == 30
    print('PASS: external pause/play settings apply', flush=True)
    old_process = extension('return e._process.get_identifier();')
    extension('e._process.force_exit();return 1;')
    for i in range(60):
        recovered = extension('return Boolean(e._ready && e._process && '
            f'e._process.get_identifier() !== {json.dumps(old_process)});')
        if recovered: break
        time.sleep(.5)
    else: raise RuntimeError('Renderer did not recover after a crash')
    assert stats()['sent']['rate'] == 30
    print('PASS: renderer crash recovery', flush=True)
    evaluate(f"Main.extensionManager.disableExtension('{UUID}'); 1")
    time.sleep(1)
    assert evaluate("global.get_window_actors().filter(a=>a.meta_window?.title?.startsWith('@deskworlds-renderer!')).length") == 0
    assert 'JS ERROR' not in log_path.read_text()
    assert "Can't update stage views" not in log_path.read_text()
    assert 'g_subprocess_force_exit' not in log_path.read_text()
    print('PASS: clean disable and no clone allocation warnings', flush=True)
finally:
    shell.terminate()
    try: shell.wait(timeout=10)
    except subprocess.TimeoutExpired: shell.kill(); shell.wait()
    log.close()
