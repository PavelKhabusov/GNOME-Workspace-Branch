// Pin Picture-in-Picture windows to every workspace, always on top.
//
// На статических воркспейсах (extension сам гасит dynamic-workspaces) PiP-окно
// Firefox/Chrome остаётся висеть на том воркспейсе, где его создали — при
// переключении колонки видео пропадает. Тут мы ловим такие окна и зовём
// make_on_all_workspaces() — нативный аналог «Always on Visible Workspace» —
// плюс make_above(), чтобы видео гарантированно было поверх остальных окон.
//
// Детект по заголовку: и Firefox ("Picture-in-Picture"), и Chrome/Chromium
// ("Picture in picture" / document-PiP "Picture-in-Picture") ставят узнаваемый
// title. Title часто ещё пуст в момент window-created, поэтому держим подписку
// на notify::title до первого совпадения и снимаем её, как только закрепили
// окно (или окно уехало).
//
// Тоггл: ключ `pin-pip-windows` (по умолчанию true). Выключение перестаёт
// закреплять НОВЫЕ окна; уже закреплённые не трогаем — отлипнут сами при
// закрытии PiP.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

// "Picture-in-Picture", "Picture in picture", любая смесь регистра/дефисов.
// + локализованные заголовки основных браузеров (ru/es/de/fr/pt/it) — Firefox
// под локалью переводит окно («Картинка в картинке», «Imagen en imagen»…) и
// английский regex его не ловил, окно болталось на одной колонке.
const PIP_TITLE_RE = /picture[\s-]*in[\s-]*picture|картинка\s*в\s*картинке|imagen\s*en\s*imagen|bild[\s-]*in[\s-]*bild|incrustation\s*vid[ée]o|imagem\s*em\s*imagem|immagine\s*nell'?immagine/i;

// X11: Firefox ставит WM_WINDOW_ROLE="PictureInPicture" — это надёжнее title,
// которое может приходить с задержкой и/или быть локализовано.
const PIP_ROLE_RE = /picture[\s-]*in[\s-]*picture|^pip$/i;

let _settings = null;
let _settingsId = 0;
let _windowCreatedId = 0;
let _workspaceSwitchedId = 0;
let _activeChangedId = 0;
let _windowGroupTxId = 0;
let _windowGroupTyId = 0;
let _enabled = false;

// window -> handler id для подписки notify::title, чтобы корректно отцепить.
const _pendingByWindow = new WeakMap();

// Закреплённые PiP-окна — при переключении workspace мы их вручную
// переносим в активный workspace. На Wayland make_on_all_workspaces()
// для XWayland-окон браузеров (Firefox/Chrome PiP) Mutter показывает
// только на исходном — таскаем сами, это работает всегда.
const _pinned = new Set();

// Эфемерные типы (меню, тултипы, выпадашки) никогда не PiP — их пропускаем,
// чтобы не цепляться к коротко живущим оверлеям. А вот NORMAL/UTILITY/DIALOG
// — кандидаты: Firefox под Wayland делает PiP окном типа UTILITY, поэтому
// жёстко требовать NORMAL нельзя. Решает заголовок.
const SKIP_TYPES = new Set([
    Meta.WindowType.DESKTOP,
    Meta.WindowType.DOCK,
    Meta.WindowType.DROPDOWN_MENU,
    Meta.WindowType.POPUP_MENU,
    Meta.WindowType.TOOLTIP,
    Meta.WindowType.NOTIFICATION,
    Meta.WindowType.COMBO,
    Meta.WindowType.DND,
    Meta.WindowType.MENU,
    Meta.WindowType.SPLASHSCREEN,
]);

function skippableType(win) {
    let type;
    try { type = win.window_type; } catch { return true; }
    return SKIP_TYPES.has(type);
}

function isPip(win) {
    if (!win) return false;
    if (skippableType(win)) return false;
    let title = '';
    try { title = (win.get_title && win.get_title()) || ''; } catch {}
    if (title && PIP_TITLE_RE.test(title)) return true;
    let role = '';
    try { role = (win.get_role && win.get_role()) || ''; } catch {}
    if (role && PIP_ROLE_RE.test(role)) return true;
    return false;
}

function pin(win) {
    // Держим окно поверх и помечаем как «следовать за активным workspace».
    // make_on_all_workspaces одного мало: для XWayland-окон браузеров
    // Mutter STICKY-флаг иногда игнорирует и окно видно только там, где
    // его создали. Поэтому в дополнение к флагу мы сами слушаем
    // workspace-switched и тянем окно в активный (см. onWorkspaceSwitched).
    let title = '';
    try { title = (win.get_title && win.get_title()) || ''; } catch {}
    try {
        if (win.make_on_all_workspaces
            && !(win.is_on_all_workspaces && win.is_on_all_workspaces()))
            win.make_on_all_workspaces();
    } catch (e) { console.log(`[workspace-branch] pip make_on_all_workspaces: ${e.message}`); }
    try {
        if (win.make_above && !(win.is_above && win.is_above()))
            win.make_above();
    } catch (e) { console.log(`[workspace-branch] pip make_above: ${e.message}`); }
    if (!_pinned.has(win)) {
        _pinned.add(win);
        try { win.connect('unmanaged', () => _pinned.delete(win)); } catch {}
    }
    console.log(`[workspace-branch] pip pinned: "${title}"`);
}

function dragPinnedToActive(activeWs) {
    if (!activeWs) return;
    const targetIdx = activeWs.index ? activeWs.index() : -1;
    for (const win of _pinned) {
        try {
            const curWs = win.get_workspace && win.get_workspace();
            const curIdx = curWs && curWs.index ? curWs.index() : -2;
            if (curIdx !== targetIdx && win.change_workspace_by_index) {
                win.change_workspace_by_index(targetIdx, false);
            }
            if (win.raise) win.raise();
            // Подстраховка: повторно поднимем «выше» — иногда новая колонка
            // перерисовывает window-stack и сбрасывает above-флаг.
            if (win.make_above && !(win.is_above && win.is_above())) {
                win.make_above();
            }
        } catch (e) {
            console.log(`[workspace-branch] pip drag: ${e.message}`);
        }
    }
}

// Переносим окно СРАЗУ, без idle. Любая задержка (включая idle_add) даёт
// workspace-switch-анимации стартовать с PiP на старом ws — пользователь
// видит «телепортацию» уже после анимации. Синхронный перенос на самый
// ранний доступный сигнал убирает этот лаг: анимация уже играется
// относительно нового положения PiP.
function onActiveChanged() {
    if (!_pinned.size) return;
    const activeWs = global.workspace_manager.get_active_workspace();
    dragPinnedToActive(activeWs);
}

function onWorkspaceSwitched() {
    if (!_pinned.size) return;
    const activeWs = global.workspace_manager.get_active_workspace();
    // Подстраховка — иногда между active-workspace-changed и финальным
    // workspace-switched сам Mutter (или другой extension) успевает
    // вернуть окно на исходный ws. Тянем ещё раз без задержки.
    dragPinnedToActive(activeWs);
    // После окончания анимации компенсация смещения уже не нужна — сбросим
    // translation на актёрах, чтобы окно стало на свою настоящую координату.
    for (const win of _pinned) {
        const actor = win.get_compositor_private && win.get_compositor_private();
        if (actor) { actor.translation_x = 0; actor.translation_y = 0; }
    }
}

// Компенсация смещения window_group: пока swipe/анимация workspace тянет
// весь window_group по экрану, мы зеркалим translation на актёрах PiP-окон,
// и они визуально стоят на месте. Это убирает "лаг" между свайпом и
// доездом окна — оно вообще не едет.
function onWindowGroupTransformed() {
    if (!_pinned.size) return;
    const wg = global.window_group;
    const tx = wg.translation_x || 0;
    const ty = wg.translation_y || 0;
    for (const win of _pinned) {
        const actor = win.get_compositor_private && win.get_compositor_private();
        if (!actor) continue;
        // Только если actor сам внутри window_group (а не клона) —
        // переотрицаем смещение.
        actor.translation_x = -tx;
        actor.translation_y = -ty;
    }
}

function clearPending(win) {
    const ids = _pendingByWindow.get(win);
    if (!ids) return;
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
        try { win.disconnect(id); } catch {}
    }
    _pendingByWindow.delete(win);
}

// true — закрепили (или уже закреплено), подписка больше не нужна.
function tryPin(win) {
    if (!_enabled) return true;
    if (isPip(win)) {
        pin(win);
        return true;
    }
    return false;
}

// Подписка на title/role до первого совпадения. Title часто приходит позже
// window-created; role в некоторых случаях (Firefox X11) выставляется ещё
// позже title, поэтому слушаем обе нотификации одновременно.
function watchUntilPinned(win) {
    if (tryPin(win)) return;
    const onChange = () => {
        if (tryPin(win)) clearPending(win);
    };
    const ids = [];
    try { ids.push(win.connect('notify::title', onChange)); } catch {}
    try { ids.push(win.connect('notify::role', onChange)); } catch {}
    try { ids.push(win.connect('notify::wm-class', onChange)); } catch {}
    _pendingByWindow.set(win, ids);
    try { win.connect('unmanaged', () => clearPending(win)); } catch {}
}

function onWindowCreated(_display, win) {
    if (!win) return;
    if (skippableType(win)) return;

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
            let t = '?', ty = '?', role = '?', cls = '?';
            try { t = (win.get_title && win.get_title()) || ''; } catch {}
            try { ty = win.window_type; } catch {}
            try { role = (win.get_role && win.get_role()) || ''; } catch {}
            try { cls = (win.get_wm_class && win.get_wm_class()) || ''; } catch {}
            console.log(`[workspace-branch] pip window-created: type=${ty} title="${t}" role="${role}" class="${cls}"`);
            watchUntilPinned(win);
        } catch {}
        return GLib.SOURCE_REMOVE;
    });
}

function loadFromSettings() {
    _enabled = _settings ? _settings.get_boolean('pin-pip-windows') : true;
}

export function install(settings) {
    _settings = settings;
    if (settings) {
        loadFromSettings();
        _settingsId = settings.connect('changed::pin-pip-windows',
            () => loadFromSettings());
    } else {
        _enabled = true;
    }
    _windowCreatedId = global.display.connect('window-created', onWindowCreated);
    _workspaceSwitchedId = global.workspace_manager.connect(
        'workspace-switched', onWorkspaceSwitched);
    _activeChangedId = global.workspace_manager.connect(
        'active-workspace-changed', onActiveChanged);
    // Зеркалим любое смещение window_group (workspace swipe, overview
    // gesture, top-panel-свайп) — это удерживает PiP визуально на месте
    // во время анимации, а не «доезжает» после неё.
    _windowGroupTxId = global.window_group.connect(
        'notify::translation-x', onWindowGroupTransformed);
    _windowGroupTyId = global.window_group.connect(
        'notify::translation-y', onWindowGroupTransformed);
    // Initial sweep: PiP-окно могло открыться ДО enable extension (reload
    // shell с открытым плеером — обычный кейс). window-created для таких
    // окон уже не выстрелит, поэтому проходимся вручную и подписываемся на
    // notify::title|role|wm-class — тогда и закреплённый, и переименованный
    // позже PiP попадут под pin().
    try {
        const actors = global.get_window_actors ? global.get_window_actors() : [];
        for (const a of actors) {
            const w = a.get_meta_window && a.get_meta_window();
            if (!w) continue;
            if (skippableType(w)) continue;
            watchUntilPinned(w);
        }
    } catch (e) { console.log(`[workspace-branch] pip-pin sweep: ${e.message}`); }
    console.log(`[workspace-branch] pip-pin installed (enabled=${_enabled})`);
}

export function uninstall() {
    if (_windowCreatedId) {
        try { global.display.disconnect(_windowCreatedId); } catch {}
        _windowCreatedId = 0;
    }
    if (_workspaceSwitchedId) {
        try { global.workspace_manager.disconnect(_workspaceSwitchedId); } catch {}
        _workspaceSwitchedId = 0;
    }
    if (_activeChangedId) {
        try { global.workspace_manager.disconnect(_activeChangedId); } catch {}
        _activeChangedId = 0;
    }
    if (_windowGroupTxId) {
        try { global.window_group.disconnect(_windowGroupTxId); } catch {}
        _windowGroupTxId = 0;
    }
    if (_windowGroupTyId) {
        try { global.window_group.disconnect(_windowGroupTyId); } catch {}
        _windowGroupTyId = 0;
    }
    // Сбросим компенсацию, чтобы окно не осталось со смещением после
    // unload extension (например при reload во время анимации).
    for (const win of _pinned) {
        const actor = win.get_compositor_private && win.get_compositor_private();
        if (actor) { actor.translation_x = 0; actor.translation_y = 0; }
    }
    if (_settingsId && _settings) {
        try { _settings.disconnect(_settingsId); } catch {}
        _settingsId = 0;
    }
    _pinned.clear();
    _settings = null;
    _enabled = false;
}
