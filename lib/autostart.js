// Per-rule autostart: правила с {autostart: true} запускают своё
// .desktop-приложение ровно один раз за сессию. Маркер живёт в
// $XDG_RUNTIME_DIR/gnome-workspace-branch/launched-this-session —
// список уже стартанутых desktop_id, по одному на строку. logout
// очищает каталог.
//
// Запускаем через Shell.App.launch — он умеет в D-Bus activation
// (Telegram), работает с обычным Exec= (Code), и не дублирует уже
// запущенные приложения. Если Shell.App.state !== STOPPED, считаем
// «уже работает» и просто помечаем маркер.

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

function readLaunched() {
    try {
        const file = Gio.File.new_for_path(statePath());
        const [ok, data] = file.load_contents(null);
        if (!ok || !data) return new Set();
        const text = new TextDecoder().decode(data);
        return new Set(text.split('\n').map(s => s.trim()).filter(Boolean));
    } catch {
        return new Set();
    }
}

function writeLaunched(set) {
    try {
        const file = Gio.File.new_for_path(statePath());
        const text = [...set].join('\n');
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

function tryLaunch() {
    const launched = readLaunched();
    const appSystem = Shell.AppSystem.get_default();
    let touched = false;
    for (const rule of rules()) {
        if (!rule || !rule.autostart) continue;
        const did = rule.match?.desktop_id;
        if (!did || launched.has(did)) continue;
        const app = appSystem.lookup_app(did);
        if (!app) {
            log(`[workspace-branch] autostart: app not found in Shell.AppSystem: ${did}`);
            continue;
        }
        // Уже запущено / стартует — не дублируем (иначе Helium показывает
        // restore-prompt, VSCode переключает фокус и т.п.).
        if (app.state !== Shell.AppState.STOPPED) {
            launched.add(did);
            touched = true;
            continue;
        }
        try {
            app.launch(0, -1, Shell.AppLaunchGpu.APP_PREF);
            launched.add(did);
            touched = true;
        } catch (e) {
            log(`[workspace-branch] autostart launch failed for ${did}: ${e.message}`);
        }
    }
    if (touched) writeLaunched(launched);
}

export function install(settings) {
    _settings = settings;
    // Стартуем только на enable extension'а / начало сессии. Тоггл «autostart»
    // в правиле руками НЕ запускает приложение — оно поднимется со следующей
    // сессии, когда tryLaunch снова отработает и маркер ещё пуст.
    tryLaunch();
}

export function uninstall() {
    _settings = null;
}
