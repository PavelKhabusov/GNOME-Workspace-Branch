// Vertical 3-finger swipe tracker.
//
// Native shell:
//   - _workspaceAnimation._swipeTracker (HORIZONTAL) — 3-finger горизонтальный
//     swipe → workspace switch. Мы не трогаем, только снапы ограничили main row.
//   - Main.overview._swipeTracker (VERTICAL) — 3-finger вертикальный → open
//     overview. Мы отключили в Swipes.enable().
//
// Этот класс — собственный SwipeTracker(VERTICAL), который слушает 3-finger
// вертикальные события и driver'ит наш VerticalMonitorGroup по progress.
// Поведение полностью аналогично нативному horizontal: можно перетянуть
// «на половину», snap к ближайшему, на отпускании ease до target.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SwipeTrackerModule from 'resource:///org/gnome/shell/ui/swipeTracker.js';

import { VerticalMonitorGroup } from './vertical-monitor-group.js';

let _topology = null;
let _tracker = null;
let _signals = [];
let _overviewSwipe = null; // {indices, basePos} когда swipe начат в overview

function controller() {
    return Main.wm?._workspaceAnimation ?? null;
}

function buildColumnIndices(t, col) {
    // Все воркспейсы в колонке от верхнего отростка к нижнему,
    // в визуальном порядке сверху вниз.
    const indices = [];
    let layer = 0;
    while (t.indexAt(col, layer - 1) !== null) layer--;
    for (; ; layer++) {
        const idx = t.indexAt(col, layer);
        if (idx === null) break;
        indices.push(idx);
    }
    return indices;
}

function prepareVerticalSwitchData(ctrl, indices, movingWindow) {
    if (ctrl._switchData) return false;

    const monitors = Main.layoutManager.monitors ?? [];
    console.log(`[workspace-branch] vertical: preparing, monitors=${monitors.length}`);

    const groups = [];
    for (const monitor of monitors) {
        try {
            console.log(`[workspace-branch] vertical: creating VMG for monitor ${monitor.index}`);
            const group = new VerticalMonitorGroup(monitor, indices, movingWindow);
            Main.uiGroup.insert_child_above(group, global.window_group);
            groups.push(group);
        } catch (e) {
            console.error(`[workspace-branch] VMG construction failed for monitor ${monitor.index}: ${e.message}\n${e.stack}`);
        }
    }

    if (groups.length === 0) {
        console.warn('[workspace-branch] no VMG created — abort vertical switch');
        return false;
    }

    const switchData = {
        monitors: groups,
        gestureActivated: false,
        inProgress: false,
        _isVertical: true, // маркер для нашего zombie-cleanup в onBegin
    };
    ctrl._switchData = switchData;

    global.compositor.disable_unredirect();
    ctrl._grab = Main.pushModal(global.stage, {
        actionMode: Shell.ActionMode.NORMAL,
    });
    return true;
}

function onBegin(tracker, monitor) {
    const ctrl = controller();
    if (!ctrl || !_topology) {
        console.log('[workspace-branch] vertical: cancel — no controller/topology');
        tracker.cancel();
        return;
    }

    // Overview path — без VMG. confirmSwipe со snap points = индексы стопки
    // относительно активного. На END activate target ws.
    if (Main.overview?.visible) {
        const wm = global.workspace_manager;
        const activeIdx = wm.get_active_workspace_index();
        const pos = _topology.positionOf(activeIdx);
        if (!pos) {
            console.log('[workspace-branch] vertical-overview: no pos, cancel');
            tracker.cancel();
            return;
        }
        const indices = buildColumnIndices(_topology, pos.col);
        const basePos = indices.indexOf(activeIdx);
        if (indices.length < 2 || basePos < 0) {
            console.log(`[workspace-branch] vertical-overview: column too short (${indices.length}), cancel`);
            tracker.cancel();
            return;
        }
        const monGeo = Main.layoutManager.monitors[monitor] ?? Main.layoutManager.primaryMonitor;
        const baseDistance = monGeo?.height ?? 800;
        const snapPoints = indices.map((_, i) => i - basePos);
        _overviewSwipe = { indices, basePos };
        console.log(`[workspace-branch] vertical-overview begin: col=${pos.col} basePos=${basePos} ` +
            `indices=[${indices.join(',')}] snap=[${snapPoints.join(',')}] dist=${baseDistance}`);
        tracker.confirmSwipe(baseDistance, snapPoints, 0, 0);
        return;
    }
    if (ctrl._switchData) {
        const sd = ctrl._switchData;
        // Чистим:
        //  - любой наш _isVertical state (от прошлого swipe или от animateSwitch
        //    создания отростка — animation onComplete не всегда успевает до swipe);
        //  - state с gestureActivated=true — это всегда не native horizontal
        //    swipe in flight (native в этом состоянии не позволил бы наш begin
        //    через capture phase), значит безопасно;
        //  - state с пустым monitors — точно наш fail.
        if (sd._isVertical || sd.gestureActivated ||
            !sd.monitors || sd.monitors.length === 0) {
            console.log('[workspace-branch] vertical: clearing zombie switchData ' +
                `(vertical=${!!sd._isVertical} gestureActivated=${sd.gestureActivated} ` +
                `monitors=${sd.monitors?.length})`);
            ctrl._finishWorkspaceSwitch(sd);
        } else {
            console.log('[workspace-branch] vertical: cancel — native switch in progress');
            tracker.cancel();
            return;
        }
    }

    const wm = global.workspace_manager;
    const activeIdx = wm.get_active_workspace_index();
    const pos = _topology.positionOf(activeIdx);
    if (!pos) {
        console.log('[workspace-branch] vertical: cancel — no positionOf for active');
        tracker.cancel();
        return;
    }

    const indices = buildColumnIndices(_topology, pos.col);
    console.log(`[workspace-branch] vertical begin: col=${pos.col} layer=${pos.layer} ` +
        `column=[${indices.join(',')}] monitor=${monitor}`);
    if (indices.length < 2) {
        tracker.cancel();
        return;
    }

    if (ctrl._switchData?.gestureActivated) {
        for (const g of ctrl._switchData.monitors)
            g.remove_all_transitions();
    } else {
        const ok = prepareVerticalSwitchData(ctrl, indices, ctrl.movingWindow);
        if (!ok) {
            console.log('[workspace-branch] vertical: cancel — prepare failed');
            tracker.cancel();
            return;
        }
    }

    const monitorGroup = ctrl._switchData.monitors.find(m => m.index === monitor);
    if (!monitorGroup) {
        console.log(`[workspace-branch] vertical: cancel — no group for monitor ${monitor}, have ${ctrl._switchData.monitors.length}`);
        tracker.cancel();
        return;
    }

    const baseDistance   = monitorGroup.baseDistance;
    const startProgress  = monitorGroup.progress;
    const closestWs      = monitorGroup.findClosestWorkspace(startProgress);
    const cancelProgress = monitorGroup.getWorkspaceProgress(closestWs);
    const points         = monitorGroup.getSnapPoints();

    ctrl._switchData.baseMonitorGroup = monitorGroup;
    tracker.confirmSwipe(baseDistance, points, startProgress, cancelProgress);
}

function onUpdate(_tracker, progress) {
    if (_overviewSwipe) return; // в overview визуальной обратной связи нет
    const ctrl = controller();
    if (!ctrl?._switchData) return;
    for (const monitorGroup of ctrl._switchData.monitors)
        monitorGroup.updateSwipeForMonitor(progress, ctrl._switchData.baseMonitorGroup);
}

function onEnd(_tracker, duration, endProgress) {
    if (_overviewSwipe) {
        const { indices, basePos } = _overviewSwipe;
        _overviewSwipe = null;
        const offset = Math.round(endProgress);
        const target = Math.max(0, Math.min(indices.length - 1, basePos + offset));
        const targetIdx = indices[target];
        console.log(`[workspace-branch] vertical-overview end: endProgress=${endProgress.toFixed(2)} ` +
            `offset=${offset} target=${targetIdx}`);
        const ws = global.workspace_manager.get_workspace_by_index(targetIdx);
        if (ws && !ws.active)
            ws.activate(Clutter.get_current_event_time());
        return;
    }

    const ctrl = controller();
    if (!ctrl?._switchData) return;

    const switchData = ctrl._switchData;
    switchData.gestureActivated = true;

    const targetWs = switchData.baseMonitorGroup.findClosestWorkspace(endProgress);
    const endTime  = Clutter.get_current_event_time();

    for (const monitorGroup of switchData.monitors) {
        const progress = monitorGroup.getWorkspaceProgress(targetWs);
        const params = {
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        };
        if (monitorGroup.index === Main.layoutManager.primaryIndex) {
            params.onComplete = () => {
                if (!targetWs.active) targetWs.activate(endTime);
                ctrl._finishWorkspaceSwitch(switchData);
            };
        }
        monitorGroup.ease_property('progress', progress, params);
    }
}

export function install(topology) {
    if (_tracker) return;
    _topology = topology;

    _tracker = new SwipeTrackerModule.SwipeTracker(
        global.stage,
        Clutter.Orientation.VERTICAL,
        Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
        {
            allowDrag: false,
            allowScroll: false,
            phase: Clutter.EventPhase.CAPTURE,
            name: 'workspace-branch vertical tracker',
        },
    );
    _tracker.orientation = Clutter.Orientation.VERTICAL;

    _signals.push(_tracker.connect('begin',  onBegin));
    _signals.push(_tracker.connect('update', onUpdate));
    _signals.push(_tracker.connect('end',    onEnd));

    console.log('[workspace-branch] vertical swipe tracker installed');
}

export function uninstall() {
    if (!_tracker) return;
    for (const id of _signals) _tracker.disconnect(id);
    _signals = [];
    _tracker.destroy?.();
    _tracker = null;
    _topology = null;
}
