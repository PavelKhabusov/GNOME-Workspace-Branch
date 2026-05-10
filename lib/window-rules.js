// Window-routing engine. Слушает display::window-created, матчит окно по
// набору правил (in-memory) и переносит на нужный воркспейс топологии.
//
// Правила сюда заливает profiles.js — он собирает их из активного профиля,
// либо (если профиль не активен) из плоского ключа `window-rules`.
//
// Формат одного правила:
//   {
//     "match": {
//       "desktop_id": "firefox.desktop",  // привязка к .desktop через Shell.WindowTracker
//       "wm_class":   "Firefox",          // строгое совпадение
//       "app_id":     "org.mozilla.firefox",
//       "title":      "^Project — .*",   // regex по заголовку
//       "pid_comm":   "Unity"            // имя процесса из /proc/<pid>/comm
//     },
//     "target": {
//       "col":   1,                       // авто-расширяется до col, если короче
//       "layer": 0                        // ±N автосоздаётся как отросток
//     },
//     "stack": true                       // каждое следующее окно этого .desktop
//                                          // едет на layer +1, +2, ... (авто-создаются)
//   }
// Совпадение — AND по всем заданным полям; первое сматчившееся — победитель.
//
// Тайминг: wm_class/title часто ещё не выставлены в момент window-created —
// откладываем первую проверку до idle-тика, и если не сматчилось, добиваем
// одной попыткой по notify::wm-class.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

let _topology = null;
let _ops = null;
let _rules = [];
let _windowCreatedId = 0;
const _pendingByWindow = new WeakMap();

function readProcComm(pid) {
    if (!pid || pid <= 0) return null;
    try {
        const file = Gio.File.new_for_path(`/proc/${pid}/comm`);
        const [ok, data] = file.load_contents(null);
        if (!ok || !data) return null;
        return new TextDecoder().decode(data).trim();
    } catch {
        return null;
    }
}

function sanitize(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.filter(r => r && typeof r === 'object'
        && r.match && typeof r.match === 'object'
        && r.target && typeof r.target === 'object'
        && typeof r.target.col === 'number');
}

function matchesRule(rule, win) {
    const m = rule.match;

    if (m.desktop_id !== undefined) {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker && tracker.get_window_app(win);
        const id = app ? app.get_id() : null;
        if (id !== m.desktop_id) return false;
    }

    if (m.wm_class !== undefined) {
        const wc = (win.get_wm_class && win.get_wm_class()) || null;
        if (wc !== m.wm_class) return false;
    }

    if (m.app_id !== undefined) {
        const gtkId = (win.get_gtk_application_id && win.get_gtk_application_id()) || null;
        const sbId  = (win.get_sandbox_id && win.get_sandbox_id()) || null;
        if (gtkId !== m.app_id && sbId !== m.app_id) return false;
    }

    if (m.title !== undefined) {
        const title = (win.get_title && win.get_title()) || '';
        try {
            const re = new RegExp(m.title);
            if (!re.test(title)) return false;
        } catch {
            return false;
        }
    }

    if (m.pid_comm !== undefined) {
        const pid = win.get_pid && win.get_pid();
        if (readProcComm(pid) !== m.pid_comm) return false;
    }

    return true;
}

function resolveTargetIdx(target) {
    const t = _topology;
    if (!t) return null;
    const col = target.col;
    if (typeof col !== 'number' || col < 0) return null;
    // Сейф-лимит против опечатки col=99.
    if (col >= t.mainRowSize + 32) return null;
    const layer = typeof target.layer === 'number' ? target.layer : 0;

    // Главное правило: если в топологии нет нужной точки — она создаётся.
    if (col >= t.mainRowSize) {
        _ops.extendMainRowTo(col);
        if (col >= t.mainRowSize) return null;
    }

    let idx = t.indexAt(col, layer);
    if (idx === null && layer !== 0) {
        // Слой ±N: создаём отростки по одному, пока не дотянемся до нужного.
        const dir = layer < 0 ? 'up' : 'down';
        let safety = 32;
        while (idx === null && safety-- > 0) {
            const created = _ops.create(col, dir);
            if (created === null) break;
            idx = t.indexAt(col, layer);
        }
    }
    return idx;
}

// Stack: ищем самый глубокий в направлении стека слой колонки, где
// уже есть окно этого приложения. Следующий стак едет на +1 от него.
// Если ничего нет — возвращаем base (первая стопка едет на саму цель).
// Использование `positionOf` вместо «count of N windows» делает stack
// устойчивым к вращению барабана: после rotateColumn абсолютные номера
// слоёв сдвигаются, но «самый глубокий занятый» остаётся валидным.
function nextStackLayer(col, baseLayer, desktopId, currentWin) {
    const tracker = Shell.WindowTracker.get_default();
    if (!tracker) return baseLayer;
    const sign = baseLayer >= 0 ? 1 : -1;
    const wm = global.workspace_manager;
    let maxLayer = null;
    for (let i = 0; i < wm.n_workspaces; i++) {
        const p = _topology.positionOf(i);
        if (!p || p.col !== col) continue;
        // Учитываем только слои в направлении стека (включая базовый).
        if (sign > 0 ? p.layer < baseLayer : p.layer > baseLayer) continue;
        const ws = wm.get_workspace_by_index(i);
        if (!ws) continue;
        const hasApp = ws.list_windows().some(w => {
            if (w === currentWin) return false;
            if (w.skip_taskbar || (w.is_on_all_workspaces && w.is_on_all_workspaces())) return false;
            const app = tracker.get_window_app(w);
            return app && app.get_id() === desktopId;
        });
        if (!hasApp) continue;
        if (maxLayer === null
            || (sign > 0 && p.layer > maxLayer)
            || (sign < 0 && p.layer < maxLayer)) {
            maxLayer = p.layer;
        }
    }
    return maxLayer === null ? baseLayer : maxLayer + sign;
}

function tryApply(win) {
    if (!win || !_rules.length) return false;
    if (win.window_type !== Meta.WindowType.NORMAL) return false;
    for (const rule of _rules) {
        if (!matchesRule(rule, win)) continue;
        let target = rule.target;
        // Stack: каждое следующее окно того же приложения едет на layer +N
        // относительно базового target.layer. При N=0 — обычный target.
        if (rule.stack && rule.match?.desktop_id) {
            const baseLayer = target.layer ?? 0;
            const layer = nextStackLayer(target.col, baseLayer,
                rule.match.desktop_id, win);
            if (layer !== baseLayer) target = { ...target, layer };
        }
        const idx = resolveTargetIdx(target);
        if (idx === null) return false;
        try {
            win.change_workspace_by_index(idx, false);
        } catch {
            return false;
        }
        return true;
    }
    return false;
}

function onWindowCreated(_display, win) {
    if (!win || win.window_type !== Meta.WindowType.NORMAL) return;

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
            if (tryApply(win)) return GLib.SOURCE_REMOVE;
            const id = win.connect('notify::wm-class', () => {
                try { tryApply(win); } catch {}
                const cached = _pendingByWindow.get(win);
                if (cached) {
                    try { win.disconnect(cached); } catch {}
                    _pendingByWindow.delete(win);
                }
            });
            _pendingByWindow.set(win, id);
        } catch {}
        return GLib.SOURCE_REMOVE;
    });
}

export function setRules(rules) {
    _rules = sanitize(rules);
}

let _settings = null;
let _settingsId = 0;

function loadFromSettings() {
    try {
        const arr = JSON.parse(_settings.get_string('window-rules'));
        setRules(Array.isArray(arr) ? arr : []);
    } catch {
        setRules([]);
    }
}

export function install(topology, ops, settings) {
    _topology = topology;
    _ops = ops;
    _settings = settings;
    if (settings) {
        loadFromSettings();
        _settingsId = settings.connect('changed::window-rules',
            () => loadFromSettings());
    } else {
        _rules = [];
    }
    _windowCreatedId = global.display.connect('window-created', onWindowCreated);
}

export function uninstall() {
    if (_windowCreatedId) {
        try { global.display.disconnect(_windowCreatedId); } catch {}
        _windowCreatedId = 0;
    }
    if (_settingsId && _settings) {
        try { _settings.disconnect(_settingsId); } catch {}
        _settingsId = 0;
    }
    _settings = null;
    _topology = null;
    _ops = null;
    _rules = [];
}
