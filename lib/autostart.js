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
        if (!did || launched.has(did)) continue;
        const app = appSystem.lookup_app(did);
        if (!app) {
            log(`[workspace-branch] autostart ${did}: not found in Shell.AppSystem`);
            continue;
        }
        const wins = (() => { try { return app.get_windows() || []; } catch { return []; } })();
        const visible = hasVisibleWindow(app);
        log(`[workspace-branch] autostart ${did}: state=${app.state} ` +
            `n_windows=${wins.length} visible=${visible}`);
        if (visible) {
            launched.add(did);
            touched = true;
            continue;
        }
        // Нет видимого окна:
        //   - STOPPED         → activate стартует процесс через .desktop;
        //   - STARTING/RUNNING → activate поднимает существующее окно
        //     или, если у приложения окон нет, спавнит новый Exec.
        // Activate — это то, что делает gnome-shell при клике в dock.
        // Если activate ничего не сделает (например, Telegram в трее не
        // понимает activate без D-Bus сигнала), фолбэк на launch.
        try {
            const winsBefore = wins.length;
            app.activate();
            // Если activate не разбудил процесс (всё ещё STOPPED) —
            // явный launch.
            if (app.state === Shell.AppState.STOPPED) {
                app.launch(0, -1, Shell.AppLaunchGpu.APP_PREF);
            }
            // Если осталось то же количество окон и stopped не сменился —
            // как fallback, пробуем Gio.Subprocess по Exec из .desktop.
            const stillSameAfter = (() => {
                try { return (app.get_windows() || []).length === winsBefore; }
                catch { return true; }
            })();
            if (stillSameAfter && app.state === Shell.AppState.STOPPED) {
                spawnFromDesktop(did);
            }
            launched.add(did);
            touched = true;
        } catch (e) {
            log(`[workspace-branch] autostart for ${did}: ${e.message}`);
        }
    }
    if (touched) writeLaunched(launched);
}

function spawnFromDesktop(desktopId) {
    try {
        const info = Gio.DesktopAppInfo.new(desktopId);
        if (!info) return;
        const cmdline = info.get_commandline();
        if (!cmdline) return;
        // Чистим placeholders %f %F %u %U и т.п.
        const cleaned = cmdline.replace(/%[fFuUdDnNickvm]/g, '').replace(/\s+/g, ' ').trim();
        const [ok, argv] = GLib.shell_parse_argv(cleaned);
        if (!ok || !argv || !argv.length) return;
        Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        log(`[workspace-branch] autostart fallback subprocess: ${argv.join(' ')}`);
    } catch (e) {
        log(`[workspace-branch] autostart fallback for ${desktopId}: ${e.message}`);
    }
}

export function install(settings) {
    _settings = settings;
    log(`[workspace-branch] autostart install`);
    // Стартуем только на enable extension'а / начало сессии. Тоггл «autostart»
    // в правиле руками НЕ запускает приложение — оно поднимется со следующей
    // сессии, когда tryLaunch снова отработает и маркер ещё пуст.
    tryLaunch();
}

export function uninstall() {
    _settings = null;
}
