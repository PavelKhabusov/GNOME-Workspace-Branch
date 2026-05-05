// Профили: набор правил + список автозапусков под именем.
//
// gsettings keys:
//   profiles        — JSON массив [{name, rules: [...], autostart: [...]}, ...]
//   active-profile  — имя активного профиля (пустая строка = без профиля)
//   window-rules    — fallback-правила, когда активного профиля нет
//
// Резолвер правил:
//   active-profile != "" и найден → берём profile.rules
//   иначе → берём window-rules
//   результат отдаём в WindowRules.setRules.
//
// Автозапуск:
//   при смене активного профиля или на enable, если профиль ещё НЕ запускался
//   в текущей сессии (пометка в $XDG_RUNTIME_DIR/.../session-profiles —
//   список уже стартанутых имён, по одному на строку), спавним каждый
//   entry.autostart[i].cmd через Gio.Subprocess. Toggle между профилями
//   A↔B автозапускает каждый ровно один раз за сессию.
//   $XDG_RUNTIME_DIR чистится при logout — следующий вход = свежий запуск.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as WindowRules from './window-rules.js';

let _settings = null;
let _changeIds = [];

function parseJSON(raw, fallback) {
    try {
        const v = JSON.parse(raw);
        return v;
    } catch { return fallback; }
}

function listProfiles() {
    const arr = parseJSON(_settings.get_string('profiles'), []);
    return Array.isArray(arr) ? arr : [];
}

function activeProfile() {
    const name = _settings.get_string('active-profile');
    if (!name) return null;
    return listProfiles().find(p => p && p.name === name) || null;
}

function applyRules() {
    const p = activeProfile();
    if (p && Array.isArray(p.rules)) {
        WindowRules.setRules(p.rules);
        return;
    }
    const fallback = parseJSON(_settings.get_string('window-rules'), []);
    WindowRules.setRules(Array.isArray(fallback) ? fallback : []);
}

function sessionStateDir() {
    const dir = `${GLib.get_user_runtime_dir()}/gnome-workspace-branch`;
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

function sessionStatePath() {
    return `${sessionStateDir()}/session-profiles`;
}

function readSessionProfiles() {
    try {
        const file = Gio.File.new_for_path(sessionStatePath());
        const [ok, data] = file.load_contents(null);
        if (!ok || !data) return new Set();
        const text = new TextDecoder().decode(data);
        return new Set(text.split('\n').map(s => s.trim()).filter(Boolean));
    } catch {
        return new Set();
    }
}

function writeSessionProfiles(set) {
    try {
        const file = Gio.File.new_for_path(sessionStatePath());
        const text = [...set].join('\n');
        file.replace_contents(new TextEncoder().encode(text), null, false,
            Gio.FileCreateFlags.NONE, null);
    } catch {}
}

function spawnAutostart(profile) {
    if (!profile || !Array.isArray(profile.autostart)) return;
    for (const entry of profile.autostart) {
        if (!entry || !Array.isArray(entry.cmd) || entry.cmd.length === 0) continue;
        try {
            Gio.Subprocess.new(entry.cmd,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            log(`[workspace-branch] autostart failed for ${entry.cmd[0]}: ${e.message}`);
        }
    }
}

function maybeRunAutostart() {
    const p = activeProfile();
    if (!p) return;
    const seen = readSessionProfiles();
    if (seen.has(p.name)) return; // уже стартан в этой сессии — не дублируем
    spawnAutostart(p);
    seen.add(p.name);
    writeSessionProfiles(seen);
}

export function install(settings) {
    _settings = settings;
    applyRules();
    maybeRunAutostart();

    _changeIds.push(_settings.connect('changed::active-profile', () => {
        applyRules();
        maybeRunAutostart();
    }));
    _changeIds.push(_settings.connect('changed::profiles', () => {
        applyRules();
    }));
    _changeIds.push(_settings.connect('changed::window-rules', () => {
        applyRules();
    }));
}

export function uninstall() {
    for (const id of _changeIds) {
        try { _settings.disconnect(id); } catch {}
    }
    _changeIds = [];
    _settings = null;
    WindowRules.setRules([]);
}
