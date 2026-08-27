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
// Активные наблюдатели за «дозревающими» окнами: Meta.Window → stop().
// Обычный Map, а не WeakMap: при uninstall() их нужно ПЕРЕБРАТЬ и погасить,
// иначе таймеры watch() продолжат тикать после disable() расширения. Каждый
// stop() сам удаляет себя отсюда, а на 'unmanaged' окно снимается в любом
// случае — так что Map не растёт.
const _pendingByWindow = new Map();

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
        // /proc/<pid>/comm — это thread-name, ограниченный 15 байтами
        // (TASK_COMM_LEN). У Unity Editor он "Unity Main Thre", у Chrome
        // — "chrome", у VS Code — "code". Чтобы юзер мог писать "Unity"
        // и попадать в "Unity Main Thre" / "UnityAutoQuitte", матчим
        // как regex.
        const pid = win.get_pid && win.get_pid();
        const comm = readProcComm(pid);
        if (!comm) return false;
        try {
            if (!new RegExp(m.pid_comm).test(comm)) return false;
        } catch {
            return false;
        }
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
// Stack: ищем самый глубокий в направлении стека слой колонки, где уже есть
// окно, попадающее под ТО ЖЕ правило. Следующий стак едет на +1 от него.
// Группируем по правилу (matchesRule), а не по desktop_id — иначе правила,
// матчащие по pid_comm / wm_class (например Unity, у которого нет привязки
// к .desktop), стекать не могли и все окна сваливались на один воркспейс,
// перекрывая друг друга.
function nextStackLayer(col, baseLayer, rule, currentWin) {
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
        const hasPeer = ws.list_windows().some(w => {
            if (w === currentWin) return false;
            if (w.window_type !== Meta.WindowType.NORMAL) return false;
            if (w.skip_taskbar || (w.is_on_all_workspaces && w.is_on_all_workspaces())) return false;
            return matchesRule(rule, w);
        });
        if (!hasPeer) continue;
        if (maxLayer === null
            || (sign > 0 && p.layer > maxLayer)
            || (sign < 0 && p.layer < maxLayer)) {
            maxLayer = p.layer;
        }
    }
    return maxLayer === null ? baseLayer : maxLayer + sign;
}

// Похоже ли окно на ПОД-окно (а не на самостоятельное главное)? Под-окна
// нельзя стекать на новый слой — они должны всплывать на воркспейсе своего
// главного окна. Признаки под-окна:
//   • есть транзиентный родитель (get_transient_for) — диалоги, пикеры;
//   • окно модальное (is_modal) — блокирующие окна Unity (загрузка, импорт);
//   • окно без заголовка (title === '') — splash / loading у Unity.
// Самостоятельные окна (новый проект в VS Code, второй редактор) ни одним из
// этих признаков не обладают и продолжают стекаться по слоям.
function looksLikeSubWindow(win) {
    try {
        if (win.get_transient_for && win.get_transient_for()) return true;
    } catch {}
    try {
        if (win.is_modal && win.is_modal()) return true;
    } catch {}
    try {
        const title = (win.get_title && win.get_title()) || '';
        if (title === '') return true;
    } catch {}
    return false;
}

// Воркспейс главного окна того же правила, куда «прилепить» под-окно. Сначала
// пробуем транзиентного родителя; иначе любое окно правила, отдавая приоритет
// активному воркспейсу (там, куда смотрит пользователь). null — главного окна
// ещё нет (тогда под-окно роутится как обычное).
function anchorWorkspaceIdx(rule, exceptWin) {
    try {
        const parent = exceptWin.get_transient_for && exceptWin.get_transient_for();
        if (parent && parent.window_type === Meta.WindowType.NORMAL
            && matchesRule(rule, parent)) {
            const ws = parent.get_workspace && parent.get_workspace();
            if (ws) return ws.index();
        }
    } catch {}

    const wm = global.workspace_manager;
    const activeIdx = wm.get_active_workspace_index();
    let fallback = null;
    for (let i = 0; i < wm.n_workspaces; i++) {
        const ws = wm.get_workspace_by_index(i);
        if (!ws) continue;
        const peer = ws.list_windows().some(w => {
            if (w === exceptWin) return false;
            if (w.window_type !== Meta.WindowType.NORMAL) return false;
            if (w.skip_taskbar || (w.is_on_all_workspaces && w.is_on_all_workspaces())) return false;
            return matchesRule(rule, w);
        });
        if (!peer) continue;
        if (i === activeIdx) return i;
        if (fallback === null) fallback = i;
    }
    return fallback;
}

function tryApply(win) {
    if (!win || !_rules.length) return false;
    if (win.window_type !== Meta.WindowType.NORMAL) return false;
    // Окно, закреплённое на всех воркспейсах (pip-pin), не роутим — иначе
    // change_workspace_by_index сорвал бы pin и прибил PiP к одной колонке.
    if (win.is_on_all_workspaces && win.is_on_all_workspaces()) return false;
    for (const rule of _rules) {
        if (!matchesRule(rule, win)) continue;

        // Куда «прилипать» к уже открытому окну этого правила (якорь):
        //  • stack-правило (VS Code) — только под-окна (transient/modal/без
        //    заголовка), чтобы самостоятельные окна разъезжались по слоям;
        //  • не-stack правило (Telegram, Helium, Steam) — ЛЮБОЕ новое окно
        //    едет к уже открытому главному, где бы оно ни было. Это чинит и
        //    попапы («Media viewer» у Telegram), и ситуацию, когда главное
        //    окно вручную перенесли в другую колонку: target.col из правила
        //    используется только для ПЕРВОГО окна приложения.
        const useAnchor = rule.stack ? looksLikeSubWindow(win) : true;
        const anchorIdx = useAnchor ? anchorWorkspaceIdx(rule, win) : null;
        let idx;
        if (anchorIdx !== null) {
            idx = anchorIdx;
        } else {
            let target = rule.target;
            // Stack: первое окно правила в свежей колонке. Каждое следующее
            // самостоятельное окно (без peer) встаёт на layer +N.
            if (rule.stack) {
                const baseLayer = target.layer ?? 0;
                const layer = nextStackLayer(target.col, baseLayer, rule, win);
                if (layer !== baseLayer) target = { ...target, layer };
            }
            idx = resolveTargetIdx(target);
        }
        if (idx === null) return false;

        // Окно уже на нужном воркспейсе — лишний change_workspace_by_index
        // только дёргает раскладку («моргание»). Считаем успехом и выходим.
        try {
            const cur = win.get_workspace && win.get_workspace();
            if (cur && cur.index() === idx) return true;
        } catch {}
        try {
            win.change_workspace_by_index(idx, false);
        } catch {
            return false;
        }
        return true;
    }
    return false;
}

// Сколько ещё «дозревать» окну, которое не сматчилось сразу. Unity и игры из
// Steam выставляют опознавательные признаки не в window-created, а спустя
// сотни миллисекунд (splash → editor; лаунчер → игра), причём wm_class у них
// меняется НЕСКОЛЬКО раз, а pid_comm (/proc/<pid>/comm) вообще не шлёт никаких
// сигналов — его можно только перечитывать.
//
// Поэтому окно наблюдаем до первого успешного матча или до истечения окна
// ожидания: слушаем wm-class И title (правила умеют матчить по обоим) и
// параллельно опрашиваем по таймеру — ради pid_comm, который иначе не поймать.
const WATCH_MS = 8000;    // общий бюджет на «дозревание» окна
const POLL_MS  = 400;     // шаг опроса (для pid_comm)

function watch(win) {
    let done = false;
    const sigs = [];
    let pollId = 0;
    let deadlineId = 0;

    const stop = () => {
        if (done) return;
        done = true;
        for (const id of sigs) {
            try { win.disconnect(id); } catch {}
        }
        sigs.length = 0;
        if (pollId) { GLib.source_remove(pollId); pollId = 0; }
        if (deadlineId) { GLib.source_remove(deadlineId); deadlineId = 0; }
        _pendingByWindow.delete(win);
    };

    const attempt = () => {
        if (done) return true;
        let ok = false;
        try { ok = tryApply(win); } catch {}
        if (ok) stop();
        return ok;
    };

    // Признаки, по которым правило может «проснуться». Раньше здесь была
    // ОДНА подписка на wm-class, и снималась она после первого же срабатывания
    // независимо от результата — поэтому окно, чей wm_class меняется дважды
    // (Unity, игры Steam), навсегда оставалось на активном воркспейсе.
    for (const prop of ['notify::wm-class', 'notify::title', 'notify::gtk-application-id']) {
        try {
            sigs.push(win.connect(prop, () => attempt()));
        } catch {}
    }

    // Опрос — единственный способ поймать pid_comm: /proc/<pid>/comm меняется
    // без всяких сигналов (Unity переписывает имя треда уже после маппинга окна).
    pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, POLL_MS, () => {
        if (done) return GLib.SOURCE_REMOVE;
        if (attempt()) return GLib.SOURCE_REMOVE;
        return GLib.SOURCE_CONTINUE;
    });

    deadlineId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, WATCH_MS, () => {
        deadlineId = 0;
        stop();
        return GLib.SOURCE_REMOVE;
    });

    _pendingByWindow.set(win, stop);

    // Окно закрыли раньше, чем дозрело — снимаем всё, чтобы таймеры не тикали
    // по мёртвому Meta.Window.
    try {
        sigs.push(win.connect('unmanaged', () => stop()));
    } catch {}
}

function onWindowCreated(_display, win) {
    if (!win || win.window_type !== Meta.WindowType.NORMAL) return;

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
            if (!tryApply(win))
                watch(win);
        } catch {}
        return GLib.SOURCE_REMOVE;
    });
}

export function setRules(rules) {
    _rules = sanitize(rules);
}

// Первое правило, под которое попадает окно, — или null. Публично, потому что
// preview-icons.js подбирает по нему иконку для окон, у которых Shell не смог
// определить приложение (Unity: нет привязки к .desktop, матчится по pid_comm).
// Специально переиспользуем matchesRule, а не дублируем матчинг: правило,
// которое роутит окно, и правило, которое даёт ему иконку, — одно и то же.
export function ruleFor(win) {
    if (!win || !_rules.length) return null;
    for (const rule of _rules) {
        try {
            if (matchesRule(rule, win)) return rule;
        } catch {}
    }
    return null;
}

// Правила — read-only для расширения: их редактирует только пользователь
// (prefs). Раньше здесь был reindexColumns(), который сдвигал target.col при
// вставке/удалении колонки главного ряда. Он и ломал автозапуск: при логауте
// окна закрываются пачкой, auto-cleanup схлопывает опустевшие колонки, каждое
// схлопывание сдвигало правила влево — и на следующем старте всё поднималось
// на колонку левее. Топология теперь подстраивается под правила (см.
// Topology.load → mainRowSize >= max(target.col) + 1), а не правила под неё.

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
    // Гасим наблюдателей за «дозревающими» окнами: у каждого свои таймеры и
    // подписки, и без этого они продолжали бы тикать после disable().
    for (const stop of [..._pendingByWindow.values()]) {
        try { stop(); } catch {}
    }
    _pendingByWindow.clear();
    if (_settingsId && _settings) {
        try { _settings.disconnect(_settingsId); } catch {}
        _settingsId = 0;
    }
    _settings = null;
    _topology = null;
    _ops = null;
    _rules = [];
}
