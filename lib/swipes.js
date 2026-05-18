// Touchpad swipes (этот модуль обрабатывает только 4-finger жесты и Super+scroll;
// 3-finger vertical вынесен в vertical-swipe.js — там через native SwipeTracker
// с прогрессом).
//
//   4 пальца вверх → лестница overview (HIDDEN → WP → APP_GRID)
//   4 пальца вниз  → лестница вниз
//   Super+scroll   → switchUp / switchDown (бэкап для не-touchpad)
//
// Отдельно патчим Main.wm.handleWorkspaceScroll: native обрабатывает scroll
// over panel/dock как UP→workspace_left, DOWN→workspace_right. Юзер хочет
// чтобы UP/DOWN в panel мапилось на topology vertical.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PANEL_SCROLL_TIMEOUT = 150;

const TRIGGER_DISTANCE  = 16; // px суммарной длины — после этого решаем направление
const SWITCH_THRESHOLD  = 50; // пиксели dy для срабатывания switch

const Phase = Clutter.TouchpadGesturePhase;

export class Swipes {
    constructor(navigator, gestureOverride = false) {
        this._nav = navigator;
        // gestureOverride: захватываем 3-finger vertical под нашу навигацию
        // и переносим overview-лестницу на 4-finger. Если false — нативное
        // 3-finger поведение не трогаем (overview/app-grid + horizontal).
        this._gestureOverride = gestureOverride;
        this._touchpadSig = 0;
        this._scrollSig = 0;

        this._cumX = 0;
        this._cumY = 0;
        this._fingers = 0;
        this._state = 'none'; // none | pending | handling | ignored

        this._touchpadSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.peripherals.touchpad',
        });
    }

    enable() {
        if (this._gestureOverride) {
            // Отключаем системный 3-finger vertical (open overview), иначе он
            // перехватывает UPDATE-события раньше нас. 4-finger overview
            // show/hide делаем мы сами.
            const ovTracker = Main.overview?._swipeTracker;
            if (ovTracker) {
                this._origOverviewSwipeEnabled = ovTracker.enabled;
                ovTracker.enabled = false;
            }

            if (!this._touchpadSig) {
                this._touchpadSig = global.stage.connect('event::touchpad',
                    (_a, e) => this._onTouchpad(e));
            }
        }

        if (!this._scrollSig) {
            this._scrollSig = global.stage.connect('scroll-event',
                (_a, e) => this._onScroll(e));
        }

        // Patch Main.wm.handleWorkspaceScroll, чтобы scroll над panel/dock
        // работал по нашей топологии: UP→switchUp, DOWN→switchDown,
        // LEFT→switchLeft, RIGHT→switchRight.
        if (Main.wm && !this._origHandleWsScroll) {
            this._origHandleWsScroll = Main.wm.handleWorkspaceScroll;
            const nav = this._nav;
            const self = this;
            Main.wm.handleWorkspaceScroll = function (event) {
                if (event.type() !== Clutter.EventType.SCROLL)
                    return Clutter.EVENT_PROPAGATE;
                const dir = event.get_scroll_direction();
                if (dir === Clutter.ScrollDirection.SMOOTH)
                    return Clutter.EVENT_PROPAGATE;
                if (self._panelScrollCooldown) return Clutter.EVENT_STOP;

                let handled = true;
                switch (dir) {
                case Clutter.ScrollDirection.UP:    nav.switchUp();    break;
                case Clutter.ScrollDirection.DOWN:  nav.switchDown();  break;
                case Clutter.ScrollDirection.LEFT:  nav.switchLeft();  break;
                case Clutter.ScrollDirection.RIGHT: nav.switchRight(); break;
                default: handled = false;
                }
                if (!handled) return Clutter.EVENT_PROPAGATE;

                self._panelScrollCooldown = true;
                GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, PANEL_SCROLL_TIMEOUT, () => {
                    self._panelScrollCooldown = false;
                });
                return Clutter.EVENT_STOP;
            };
        }

        console.log('[workspace-branch] swipes enabled');
    }

    disable() {
        const ovTracker = Main.overview?._swipeTracker;
        if (ovTracker && this._origOverviewSwipeEnabled !== undefined) {
            ovTracker.enabled = this._origOverviewSwipeEnabled;
            this._origOverviewSwipeEnabled = undefined;
        }
        if (this._touchpadSig) {
            global.stage.disconnect(this._touchpadSig);
            this._touchpadSig = 0;
        }
        if (this._scrollSig) {
            global.stage.disconnect(this._scrollSig);
            this._scrollSig = 0;
        }
        if (this._origHandleWsScroll && Main.wm) {
            Main.wm.handleWorkspaceScroll = this._origHandleWsScroll;
            this._origHandleWsScroll = null;
        }
        this._reset();
    }

    _reset() {
        this._cumX = 0;
        this._cumY = 0;
        this._fingers = 0;
        this._state = 'none';
        this._smoothAccum = 0;
        this._smoothCooldown = false;
    }

    _onTouchpad(event) {
        if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;

        const phase = event.get_gesture_phase();
        const fingers = event.get_touchpad_gesture_finger_count();

        if (phase === Phase.BEGIN) {
            this._cumX = 0;
            this._cumY = 0;
            this._fingers = fingers;
            // 3F отдаём VerticalSwipe / native horizontal SwipeTracker;
            // здесь обрабатываем только 4F.
            this._state = (fingers === 4) ? 'pending' : 'ignored';
            return Clutter.EVENT_PROPAGATE;
        }

        if (this._state === 'ignored')
            return Clutter.EVENT_PROPAGATE;

        if (phase === Phase.UPDATE) {
            const [dx, dy] = event.get_gesture_motion_delta_unaccelerated();
            this._cumX += dx;
            this._cumY += dy;

            if (this._state === 'pending') {
                const dist = Math.hypot(this._cumX, this._cumY);
                if (dist < TRIGGER_DISTANCE)
                    return Clutter.EVENT_PROPAGATE;
                if (this._fingers === 4) {
                    this._state = 'handling';
                } else {
                    this._state = 'ignored';
                    return Clutter.EVENT_PROPAGATE;
                }
            }

            // Когда «handling» — глотаем UPDATE-события чтобы overview не открылся
            // от того же жеста.
            return Clutter.EVENT_STOP;
        }

        if (phase === Phase.END || phase === Phase.CANCEL) {
            const wasHandling = this._state === 'handling';
            const fingers = this._fingers;
            const cumY = this._cumY;
            this._reset();

            if (!wasHandling) return Clutter.EVENT_PROPAGATE;
            if (phase === Phase.CANCEL) return Clutter.EVENT_STOP;

            const natural = this._touchpadSettings.get_boolean('natural-scroll');
            const effY = natural ? cumY : -cumY;
            console.log(`[workspace-branch] swipe end fingers=${fingers} effY=${effY.toFixed(1)}`);

            if (Math.abs(effY) < SWITCH_THRESHOLD)
                return Clutter.EVENT_STOP;

            if (fingers === 4) {
                // Лестница: HIDDEN → WINDOW_PICKER → APP_GRID и обратно.
                const ctrls = Main.overview?._overview?._controls;
                if (ctrls?._shiftState) {
                    const dir = effY < 0
                        ? Meta.MotionDirection.UP
                        : Meta.MotionDirection.DOWN;
                    ctrls._shiftState(dir);
                } else {
                    if (effY < 0) Main.overview.show();
                    else          Main.overview.hide();
                }
            }
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onScroll(event) {
        const state = event.get_state();
        const hasSuper = (state & Clutter.ModifierType.SUPER_MASK) !== 0;
        if (!this._scrollLogged) {
            this._scrollLogged = true;
            console.log(`[workspace-branch] first scroll event seen (state=${state}, super=${hasSuper})`);
        }
        if (!hasSuper)
            return Clutter.EVENT_PROPAGATE;

        const dir = event.get_scroll_direction();

        if (dir === Clutter.ScrollDirection.UP)   { this._nav.switchUp();   return Clutter.EVENT_STOP; }
        if (dir === Clutter.ScrollDirection.DOWN) { this._nav.switchDown(); return Clutter.EVENT_STOP; }

        if (dir !== Clutter.ScrollDirection.SMOOTH)
            return Clutter.EVENT_PROPAGATE;

        const [, dy] = event.get_scroll_delta();
        if (dy === 0) {
            this._smoothAccum = 0;
            this._smoothCooldown = false;
            return Clutter.EVENT_STOP;
        }
        if (this._smoothCooldown) return Clutter.EVENT_STOP;

        this._smoothAccum = (this._smoothAccum || 0) + dy;
        if (Math.abs(this._smoothAccum) < 8)
            return Clutter.EVENT_STOP;

        if (this._smoothAccum < 0) this._nav.switchUp();
        else                       this._nav.switchDown();
        this._smoothAccum = 0;
        this._smoothCooldown = true;
        return Clutter.EVENT_STOP;
    }
}
