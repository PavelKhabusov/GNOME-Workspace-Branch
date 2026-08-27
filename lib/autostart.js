// Session restore: при входе поднимаем приложения из ДВУХ источников —
//   1. снапшот прошлой сессии: что было реально открыто в прошлый раз;
//   2. правила с {autostart: true}: их .desktop поднимаем ВСЕГДА, был ли
//      app открыт в прошлый раз или нет (галочка «autostart» в prefs).
// Списки объединяются; закрытые перед выходом и не помеченные autostart — не
// трогаем.
//
// Как это работает:
//   • Подписываемся на Shell.AppSystem::app-state-changed и при каждом
//     изменении пишем снапшот running-приложений (desktop_id с видимым окном)
//     в persistent-файл ~/.local/state/gnome-workspace-branch/session-apps.
//   • При enable() — один раз за процесс shell — читаем ПРОШЛЫЙ снапшот,
//     добавляем desktop_id правил с autostart:true и запускаем те приложения,
//     что сейчас ещё не открыты.
//
// Почему «раз за процесс shell»: процесс gnome-shell живёт ровно одну
// графическую сессию. На Wayland релогин = новый процесс shell с тем же
// boot-id, поэтому boot-id релогины не различает, а in-memory флаг — да.
// Так restore срабатывает при каждом входе в сессию, но не повторяется,
// если расширение просто передёрнули (disable/enable) внутри сессии.
//
// Снапшот лежит в state-dir (а не runtime-dir): runtime-dir чистится между
// сессиями, а нам нужно пережить логаут.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

let _settings = null;
let _appSystem = null;
let _stateChangedId = 0;
let _saveSource = 0;
let _restoreSource = 0;

// Снапшот текущей сессии перезаписываем только ПОСЛЕ того, как восстановили
// прошлую — иначе затрём список «что было открыто» до запуска restore.
let _restoreDone = false;

function stateDir() {
    const dir = `${GLib.get_user_state_dir()}/gnome-workspace-branch`;
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

function snapshotPath() {
    return `${stateDir()}/session-apps`;
}

// desktop_id всех приложений, у которых есть видимое окно. PiP / skip-taskbar /
// «на всех воркспейсах» окна не считаем за «приложение, которое надо поднять».
function runningDesktopIds() {
    const ids = new Set();
    let apps;
    try { apps = _appSystem.get_running() || []; } catch { return ids; }
    for (const app of apps) {
        if (!app) continue;
        let id;
        try { id = app.get_id(); } catch { continue; }
        if (!id) continue;
        if (!hasVisibleWindow(app)) continue;
        ids.add(id);
    }
    return ids;
}

function hasVisibleWindow(app) {
    let wins;
    try { wins = app.get_windows() || []; } catch { return false; }
    for (const w of wins) {
        if (!w) continue;
        try {
            if (w.skip_taskbar) continue;
            if (w.is_on_all_workspaces && w.is_on_all_workspaces()) continue;
        } catch { continue; }
        return true;
    }
    return false;
}

function readSnapshot() {
    try {
        const file = Gio.File.new_for_path(snapshotPath());
        const [ok, data] = file.load_contents(null);
        if (!ok || !data) return [];
        return new TextDecoder().decode(data)
            .split('\n').map(s => s.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

function writeSnapshot(ids) {
    try {
        const file = Gio.File.new_for_path(snapshotPath());
        const text = [...ids].join('\n');
        file.replace_contents(new TextEncoder().encode(text), null, false,
            Gio.FileCreateFlags.NONE, null);
    } catch (e) {
        console.log(`[workspace-branch] session save: ${e.message}`);
    }
}

// Сохраняем снапшот текущей сессии — но только после restore, чтобы не
// затереть «прошлую сессию» прежде, чем мы её восстановили.
function saveSnapshot() {
    if (!_restoreDone) return;
    const ids = runningDesktopIds();
    writeSnapshot(ids);
}

// app-state-changed сыпется пачками при старте/закрытии — дебаунсим запись.
function queueSave() {
    if (_saveSource) return;
    _saveSource = GLib.timeout_add(GLib.PRIORITY_LOW, 1500, () => {
        _saveSource = 0;
        try { saveSnapshot(); } catch (e) {
            console.log(`[workspace-branch] session save: ${e.message}`);
        }
        return GLib.SOURCE_REMOVE;
    });
}

// desktop_id правил с {autostart: true}. Эти приложения поднимаем ВСЕГДА, было
// ли что-то открыто в прошлой сессии или нет — галочка «autostart» в prefs
// именно это и обещает. Матчатся только правила, привязанные к .desktop
// (desktop_id): запускать нам нечего, если правило матчит по wm_class/pid_comm.
function autostartDesktopIds() {
    if (!_settings) return [];
    let arr;
    try {
        arr = JSON.parse(_settings.get_string('window-rules'));
        if (!Array.isArray(arr)) return [];
    } catch {
        return [];
    }
    const ids = [];
    for (const r of arr) {
        if (!r || r.autostart !== true) continue;
        const id = r.match && r.match.desktop_id;
        if (typeof id === 'string' && id) ids.push(id);
    }
    return ids;
}

function restoreSession() {
    // Что поднимать: объединение снапшота прошлой сессии и правил с
    // autostart:true. Снапшот идёт первым (сохраняем прежний порядок), правила
    // добавляют то, чего в снапшоте нет; Set убирает дубли.
    const want = [...new Set([...readSnapshot(), ...autostartDesktopIds()])];
    const open = runningDesktopIds();
    console.log(`[workspace-branch] session restore: ${want.length} to restore ` +
        `(snapshot + autostart rules), ${open.size} already open`);
    for (const id of want) {
        if (open.has(id)) continue;
        const app = _appSystem.lookup_app(id);
        if (!app) {
            console.log(`[workspace-branch] session restore ${id}: not found`);
            continue;
        }
        try {
            app.activate();
            console.log(`[workspace-branch] session restore: launched ${id}`);
        } catch (e) {
            console.log(`[workspace-branch] session restore ${id}: ${e.message}`);
        }
    }
    // С этого момента снапшот отражает уже текущую сессию.
    _restoreDone = true;
    saveSnapshot();
}

export function install(settings) {
    _settings = settings;
    _appSystem = Shell.AppSystem.get_default();
    console.log('[workspace-branch] session-restore install');

    // Пишем снапшот при каждом изменении набора running-приложений.
    _stateChangedId = _appSystem.connect('app-state-changed', () => queueSave());

    // Restore — через timeout, чтобы не блокировать enable() и дать shell
    // успеть поднять уже-автозапускаемые приложения (не дублируем их).
    _restoreSource = GLib.timeout_add(GLib.PRIORITY_LOW, 1500, () => {
        _restoreSource = 0;
        try { restoreSession(); } catch (e) {
            console.log(`[workspace-branch] session restore: ${e.message}`);
        }
        return GLib.SOURCE_REMOVE;
    });
}

export function uninstall() {
    // На disable() (в т.ч. при логауте, если успеем) фиксируем актуальный
    // снапшот — но только если restore уже отработал.
    try { saveSnapshot(); } catch {}

    if (_restoreSource) {
        GLib.source_remove(_restoreSource);
        _restoreSource = 0;
    }
    if (_saveSource) {
        GLib.source_remove(_saveSource);
        _saveSource = 0;
    }
    if (_stateChangedId && _appSystem) {
        try { _appSystem.disconnect(_stateChangedId); } catch {}
        _stateChangedId = 0;
    }
    _appSystem = null;
    _settings = null;
}
