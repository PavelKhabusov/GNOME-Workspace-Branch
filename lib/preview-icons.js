// Иконки (и подписи) в overview-превью для окон, которые Shell не может
// связать с приложением.
//
// Стоковый WindowPreview._init делает так:
//
//     const app = tracker.get_window_app(this.metaWindow);
//     this._icon = app.create_icon_texture(ICON_SIZE);   // ← null-guard'а НЕТ
//
// и _getCaption() так же дёргает app.get_name(). Если tracker не смог
// определить приложение, app === null, и _init падает с TypeError — превью не
// строится вовсе (у окна нет ни иконки, ни подписи). Ровно этот случай — Unity
// Editor: его окна не привязаны ни к одному .desktop, поэтому в window-rules
// он и описан через pid_comm.
//
// Поэтому чинить пост-фактум (дорисовать иконку после _init) нельзя: до этого
// места код уже не доходит. Вместо этого подменяем сам источник —
// Shell.WindowTracker.get_window_app: если стоковый tracker вернул null, а окно
// матчится на правило с полем `icon`, отдаём синтетический «app»-объект с теми
// методами, которые нужны WindowPreview (create_icon_texture / get_name / …).
// Так иконка и подпись чинятся одним switch'ем, а весь остальной код Shell'а
// (включая будущие вызовы) работает с окном как с нормальным приложением.
//
// Формат: правило может нести поле `icon` (и опционально `name` для подписи):
//
//   { "match":  {"pid_comm": "Unity"},
//     "target": {"col": 3, "layer": 1},
//     "icon":   "unityhub.desktop",   // одолжить иконку у этого .desktop
//     "name":   "Unity" }
//
//   "icon": "applications-games"      // либо имя иконки из темы
//   "icon": "/path/to/unity.png"      // либо файл
//
// Правило для иконки ищется тем же matchesRule, что и для роутинга, поэтому
// «куда уехало окно» и «какая у него иконка» не могут разъехаться.

import Gio from 'gi://Gio';
import St from 'gi://St';
import Shell from 'gi://Shell';

import * as WindowRules from './window-rules.js';

let _origGetWindowApp = null;

// Кэш синтетических app'ов, ключ — ПРАВИЛО (не окно). Важно не только ради
// экономии: altTab группирует окна сравнением app'ов ПО ССЫЛКЕ
// (get_window_app(w) === appIcon.app). Значит все окна одного правила должны
// получать один и тот же объект — иначе три окна Unity показались бы в alt-tab
// тремя разными «приложениями». Ключ по правилу даёт ровно нужную группировку:
// одно правило = одно приложение.
//
// WeakMap по объекту правила: _rules пересоздаётся на каждый changed::
// window-rules, поэтому старые записи уходят вместе со старыми правилами.
const _fakeApps = new WeakMap();

// `icon` из правила → Gio.Icon. Три формы, по убыванию специфичности:
//   • "*.desktop" — одолжить иконку у приложения (самый частый случай: у Unity
//     Editor нет своего .desktop, но есть unityhub.desktop с той же иконкой);
//   • абсолютный путь — иконка из файла;
//   • иначе — имя иконки в теме.
function giconFromSpec(spec) {
    if (typeof spec !== 'string' || !spec) return null;

    if (spec.endsWith('.desktop')) {
        try {
            const appSys = Shell.AppSystem.get_default();
            const app = appSys && appSys.lookup_app(spec);
            const info = app && app.get_app_info && app.get_app_info();
            const gicon = info && info.get_icon();
            if (gicon) return gicon;
        } catch {}
        return null;
    }

    if (spec.startsWith('/')) {
        try {
            const file = Gio.File.new_for_path(spec);
            if (file.query_exists(null))
                return new Gio.FileIcon({ file });
        } catch {}
        return null;
    }

    try {
        return Gio.ThemedIcon.new(spec);
    } catch {
        return null;
    }
}

// Все окна, попадающие под правило — «окна этого приложения».
function windowsOfRule(rule) {
    const out = [];
    try {
        for (const actor of global.get_window_actors()) {
            const w = actor.meta_window;
            if (!w) continue;
            if (WindowRules.ruleFor(w) === rule) out.push(w);
        }
    } catch {}
    return out;
}

// Минимальный утиный «Shell.App» — ровно та поверхность, которую трогают
// WindowPreview (иконка + подпись) и соседи по списку потребителей
// get_window_app (altTab, ctrlAltTab, closeDialog, windowAttentionHandler).
// Не наследуем Shell.App: это GObject с внутренним состоянием и приватным
// связыванием с .desktop — а нам нужен только источник иконки и имени.
//
// Объект живёт на ПРАВИЛО, а не на окно, поэтому все методы работают с набором
// окон правила, а не с одним конкретным.
function makeFakeApp(gicon, rule) {
    const displayName = rule.name;
    return {
        create_icon_texture(size) {
            return new St.Icon({ gicon, icon_size: size });
        },
        get_icon() {
            return gicon;
        },
        get_name() {
            if (displayName) return displayName;
            // Без явного `name` берём wm_class первого окна — это и есть то,
            // что пользователь видит как имя приложения.
            const wins = windowsOfRule(rule);
            for (const w of wins) {
                try {
                    const wc = w.get_wm_class && w.get_wm_class();
                    if (wc) return wc;
                } catch {}
            }
            return '';
        },
        // null id — честный ответ: у этого «приложения» нет .desktop. Именно
        // поэтому Shell и не смог его опознать.
        get_id() { return null; },
        get_windows() { return windowsOfRule(rule); },
        get_n_windows() { return windowsOfRule(rule).length; },
        get_state() { return Shell.AppState.RUNNING; },
        is_window_backed() { return true; },
        can_open_new_window() { return false; },
        activate() {
            const wins = windowsOfRule(rule);
            if (wins.length) {
                try { wins[0].activate(global.get_current_time()); } catch {}
            }
        },
        activate_window(win, timestamp) {
            try { win.activate(timestamp ?? global.get_current_time()); } catch {}
        },
    };
}

function patchedGetWindowApp(win) {
    const app = _origGetWindowApp.call(this, win);
    if (app) return app;   // Shell справился сам — не вмешиваемся.
    if (!win) return app;

    let rule = null;
    try {
        rule = WindowRules.ruleFor(win);
    } catch {
        return app;
    }
    // Подменяем только там, где пользователь явно попросил иконку. Без `icon`
    // в правиле поведение остаётся стоковым.
    if (!rule || !rule.icon) return app;

    const cached = _fakeApps.get(rule);
    if (cached) return cached;

    const gicon = giconFromSpec(rule.icon);
    if (!gicon) return app;

    const fake = makeFakeApp(gicon, rule);
    _fakeApps.set(rule, fake);
    return fake;
}

export function install() {
    if (_origGetWindowApp) return;
    const proto = Shell.WindowTracker.prototype;
    if (!proto || typeof proto.get_window_app !== 'function') {
        console.warn('[workspace-branch] WindowTracker.get_window_app not patchable');
        return;
    }
    _origGetWindowApp = proto.get_window_app;
    proto.get_window_app = patchedGetWindowApp;
    console.log('[workspace-branch] preview icons: rule-based fallback installed');
}

export function uninstall() {
    if (!_origGetWindowApp) return;
    try {
        Shell.WindowTracker.prototype.get_window_app = _origGetWindowApp;
    } catch {}
    _origGetWindowApp = null;
}
