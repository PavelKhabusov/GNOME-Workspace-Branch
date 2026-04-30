// Patch Main.wm._workspaceAnimation для:
//   1) vertical transitions (та же колонка, разные слои) — анимируем сами,
//      используя VerticalMonitorGroup. Получается плавный вертикальный slide,
//      эквивалентный нативному горизонтальному.
//   2) diagonal transitions (разные колонки + не-нулевой слой хотя бы у одной
//      точки) — instant; нет осмысленного 2D slide-а.
//   3) _prepareWorkspaceSwitch — snap points при native horizontal swipe
//      ограничиваем main row.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WINDOW_ANIMATION_TIME } from
    'resource:///org/gnome/shell/ui/workspaceAnimation.js';

import { VerticalMonitorGroup } from './vertical-monitor-group.js';

let _topology = null;
let _origAnimate = null;
let _origPrepare = null;
let _controller = null;
let _activeSig = 0;
let _hSwipeWasEnabled = true;

function classify(t, from, to) {
    const fp = t.positionOf(from);
    const tp = t.positionOf(to);
    if (!fp || !tp) return 'horizontal';
    if (fp.col === tp.col && fp.layer !== tp.layer) return 'vertical';
    if (fp.col !== tp.col && (fp.layer !== 0 || tp.layer !== 0)) return 'diagonal';
    return 'horizontal'; // main↔main по горизонтали
}

function prepareVerticalSwitch(controller, workspaceIndices, movingWindow) {
    if (controller._switchData) return;

    const switchData = {};
    controller._switchData = switchData;
    switchData.monitors = [];
    switchData.gestureActivated = false;
    switchData.inProgress = false;
    switchData._isVertical = true;

    const monitors = Meta.prefs_get_workspaces_only_on_primary()
        ? [Main.layoutManager.primaryMonitor]
        : Main.layoutManager.monitors;

    for (const monitor of monitors) {
        if (Meta.prefs_get_workspaces_only_on_primary() &&
            monitor.index !== Main.layoutManager.primaryIndex)
            continue;

        const group = new VerticalMonitorGroup(monitor, workspaceIndices, movingWindow);
        Main.uiGroup.insert_child_above(group, global.window_group);
        switchData.monitors.push(group);
    }

    global.compositor.disable_unredirect();
    controller._grab = Main.pushModal(global.stage, {
        actionMode: Shell.ActionMode.NORMAL,
    });
}

function animateVerticalSwitch(controller, from, to, fromAbove, onComplete) {
    controller._swipeTracker.enabled = false;

    // workspaceIndices: при движении вверх target первый, при вниз — второй.
    const workspaceIndices = fromAbove ? [from, to] : [to, from];

    prepareVerticalSwitch(controller, workspaceIndices, controller.movingWindow);
    controller._switchData.inProgress = true;

    const fromWs = global.workspace_manager.get_workspace_by_index(from);
    const toWs   = global.workspace_manager.get_workspace_by_index(to);

    for (const monitorGroup of controller._switchData.monitors) {
        monitorGroup.progress = monitorGroup.getWorkspaceProgress(fromWs);
        const targetProgress = monitorGroup.getWorkspaceProgress(toWs);

        const params = {
            duration: WINDOW_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        };
        if (monitorGroup.index === Main.layoutManager.primaryIndex) {
            params.onComplete = () => {
                controller._finishWorkspaceSwitch(controller._switchData);
                onComplete();
                controller._swipeTracker.enabled = true;
            };
        }
        monitorGroup.ease_property('progress', targetProgress, params);
    }
}

function syncHorizontalSwipe() {
    if (!_controller || !_topology) return;
    const tracker = _controller._swipeTracker;
    if (!tracker) return;
    const activeIdx = global.workspace_manager.get_active_workspace_index();
    const isAppendage = activeIdx >= _topology.mainRowSize;
    // Когда юзер на отростке — отключаем нативный horizontal swipe, чтобы
    // его MonitorGroup не падал на отсутствующем activeWs в snap points.
    tracker.enabled = !isAppendage && _hSwipeWasEnabled;
}

export function install(topology) {
    if (_origAnimate) return;
    _controller = Main.wm?._workspaceAnimation;
    if (!_controller) {
        console.warn('[workspace-branch] _workspaceAnimation controller not found');
        return;
    }
    _topology = topology;
    _origAnimate = _controller.animateSwitch;
    _origPrepare = _controller._prepareWorkspaceSwitch;
    _hSwipeWasEnabled = _controller._swipeTracker?.enabled ?? true;

    _controller.animateSwitch = function (from, to, direction, onComplete) {
        const kind = _topology ? classify(_topology, from, to) : 'horizontal';

        if (kind === 'vertical') {
            const fp = _topology.positionOf(from);
            const tp = _topology.positionOf(to);
            // fromAbove: from визуально выше to (т.е. layer от меньше).
            const fromAbove = fp.layer < tp.layer;
            animateVerticalSwitch(this, from, to, fromAbove, onComplete);
            return;
        }
        if (kind === 'diagonal') {
            if (this._switchData && !this._switchData.gestureActivated)
                this._finishWorkspaceSwitch(this._switchData);
            onComplete();
            return;
        }
        _origAnimate.call(this, from, to, direction, onComplete);
    };

    _controller._prepareWorkspaceSwitch = function (workspaceIndices) {
        if (!workspaceIndices && _topology) {
            const main = _topology.mainRowSize;
            if (main > 0) {
                workspaceIndices = [];
                for (let i = 0; i < main; i++) workspaceIndices.push(i);
            }
        }
        _origPrepare.call(this, workspaceIndices);
    };

    _activeSig = global.workspace_manager.connect(
        'active-workspace-changed', () => syncHorizontalSwipe());
    syncHorizontalSwipe();

    console.log('[workspace-branch] animateSwitch patched (vertical animation enabled)');
}

export function uninstall() {
    if (_activeSig) {
        global.workspace_manager.disconnect(_activeSig);
        _activeSig = 0;
    }
    if (_controller) {
        if (_origAnimate) _controller.animateSwitch = _origAnimate;
        if (_origPrepare) _controller._prepareWorkspaceSwitch = _origPrepare;
        if (_controller._swipeTracker)
            _controller._swipeTracker.enabled = _hSwipeWasEnabled;
    }
    _controller = null;
    _origAnimate = null;
    _origPrepare = null;
    _topology = null;
}
