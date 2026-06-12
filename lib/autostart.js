// Per-rule autostart: правила с {autostart: true} запускают своё
// .desktop-приложение ровно один раз за boot. Маркер пишет первой
// строкой текущий boot-id, дальше — список launched desktop_id, по
// одному в строке. После suspend/resume boot-id тот же → автозапуск
// НЕ повторяется (раньше extension рестартовал app'ы, упавшие во
// время suspend — бесило в режиме самолёта). После реального reboot
// boot-id меняется → маркер сбрасывается и автозапуск отрабатывает.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

let _settings = null;

function stateDir() {
    const dir = `${GLib.get_user_runtime_dir()}/gnome-workspace-branch`;
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

function statePath() {
    return `${stateDir()}/launched-this-session`;
}

function bootId() {
    try {
        const [ok, data] = GLib.file_get_contents('/proc/sys/kernel/random/boot_id');
        if (!ok || !data) return '';
        return new TextDecoder().decode(data).trim();
    } catch {
        return '';
    }
}

function readLaunched() {
    try {
        const file = Gio.File.new_for_path(statePath());
        const [ok, data] = file.load_contents(null);
        if (!ok || !data) return new Set();
        const lines = new TextDecoder().decode(data)
            .split('\n').map(s => s.trim()).filter(Boolean);
        // First line is the boot-id this marker was written under. If it
        // doesn't match the current boot we treat the marker as empty —
        // a real reboot resets the autostart, but suspend/resume doesn't.
        const fileBoot = lines.shift() ?? '';
        if (fileBoot !== bootId()) return new Set();
        return new Set(lines);
    } catch {
        return new Set();
    }
}

function writeLaunched(set) {
    try {
        const file = Gio.File.new_for_path(statePath());
        const text = [bootId(), ...set].join('\n');
        file.replace_contents(new TextEncoder().encode(text), null, false,
            Gio.FileCreateFlags.NONE, null);
    } catch {}
}

function rules() {
    if (!_settings) return [];
    try {
        const arr = JSON.parse(_settings.get_string('window-rules'));
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
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

function tryLaunch() {
    const launched = readLaunched();
    const appSystem = Shell.AppSystem.get_default();
    const allRules = rules();
    log(`[workspace-branch] autostart tryLaunch: ${allRules.length} rules, ` +
        `${launched.size} already launched this session`);
    let touched = false;
    for (const rule of allRules) {
        if (!rule || !rule.autostart) continue;
        const did = rule.match?.desktop_id;
        if (!did) continue;
        const app = appSystem.lookup_app(did);
        if (!app) {
            log(`[workspace-branch] autostart ${did}: not found in Shell.AppSystem`);
            continue;
        }
        // Маркер «уже стартовали в этой сессии» — абсолютный. Если юзер
        // сам закрыл приложение / оно упало во время suspend — НЕ
        // перезапускаем (см. boot-id логика в readLaunched).
        if (launched.has(did)) continue;
        const wins = (() => { try { return app.get_windows() || []; } catch { return []; } })();
        const visible = hasVisibleWindow(app);
        log(`[workspace-branch] autostart ${did}: state=${app.state} ` +
            `n_windows=${wins.length} visible=${visible}`);
        if (visible) {
            launched.add(did);
            touched = true;
            continue;
        }
        try {
            app.activate();
            launched.add(did);
            touched = true;
        } catch (e) {
            log(`[workspace-branch] autostart for ${did}: ${e.message}`);
        }
    }
    if (touched) writeLaunched(launched);
}

let _launchSource = 0;

export function install(settings) {
    _settings = settings;
    log(`[workspace-branch] autostart install`);
    // Стартуем только на enable extension'а / начало сессии. Тоггл «autostart»
    // в правиле руками НЕ запускает приложение — оно поднимется со следующей
    // сессии, когда tryLaunch снова отработает и маркер ещё пуст.
    //
    // Запускаем через timeout 1 сек, чтобы не блокировать enable() —
    // Shell.App.activate() для нескольких приложений ощутимо тормозит
    // старт shell на свежей сессии.
    _launchSource = GLib.timeout_add(GLib.PRIORITY_LOW, 1000, () => {
        _launchSource = 0;
        try { tryLaunch(); } catch (e) {
            log(`[workspace-branch] autostart tryLaunch: ${e.message}`);
        }
        return GLib.SOURCE_REMOVE;
    });
}

export function uninstall() {
    if (_launchSource) {
        GLib.source_remove(_launchSource);
        _launchSource = 0;
    }
    _settings = null;
}
