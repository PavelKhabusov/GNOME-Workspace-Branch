// Замена _thumbnailsBox в overview controls на наш GridThumbnailsBox.
// Подменяем три ссылки:
//   1. controls._thumbnailsBox             — основная ссылка
//   2. controls.layout_manager._workspacesThumbnails — для allocate в ControlsManagerLayout
//   3. add_child / remove_child            — переноска actor'а в дереве
//
// Также воспроизводим notify::should-show и monitors-changed подключения,
// которые в оригинале сидят на старом инстансе и при destroy теряются.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

import { GridThumbnailsBox } from './grid-thumbnails-box.js';

const SIDE_CONTROLS_ANIMATION_TIME = 250;

let _origBox = null;
let _ourBox = null;
let _origIndex = -1;

function controls() {
    return Main.overview?._overview?._controls ?? null;
}

function attachStandardSignals(box, ctrl) {
    box.connectObject('notify::should-show', () => {
        box.show();
        box.ease_property('expand-fraction', box.should_show ? 1 : 0, {
            duration: SIDE_CONTROLS_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => ctrl._updateThumbnailsBox(),
        });
    }, box);
    Main.layoutManager.connectObject('monitors-changed', () => {
        box.setMonitorIndex(Main.layoutManager.primaryIndex);
    }, box);
}

export function install(topology, ops, settings) {
    const ctrl = controls();
    if (!ctrl) {
        console.warn('[workspace-branch] overview controls not ready');
        return;
    }
    if (_ourBox) return; // уже установлен

    const orig = ctrl._thumbnailsBox;
    if (!orig || orig instanceof GridThumbnailsBox) return;

    _origIndex = ctrl.get_children().indexOf(orig);
    const adj = orig._scrollAdjustment;
    const monIdx = orig._monitorIndex;
    const visible = orig.visible;
    const opacity = orig.opacity;
    const expand  = orig.expandFraction;

    const our = new GridThumbnailsBox(adj, monIdx, topology, ops, settings);
    our.visible       = visible;
    our.opacity       = opacity;
    our.expandFraction = expand;

    ctrl.remove_child(orig);
    orig.destroy();
    _origBox = null;

    ctrl.insert_child_at_index(our, _origIndex >= 0 ? _origIndex : -1);
    ctrl._thumbnailsBox = our;
    if (ctrl.layout_manager)
        ctrl.layout_manager._workspacesThumbnails = our;

    attachStandardSignals(our, ctrl);

    // Если overview уже был показан до swap — super._init подключился к 'showing',
    // но событие уже отгремело. Создаём thumbnails вручную.
    if (Main.overview.visible)
        our._createThumbnails();

    _ourBox = our;
    console.log(`[workspace-branch] GridThumbnailsBox installed; topology mainRowSize=${topology.mainRowSize} appendages=${topology.appendageCount}`);
}

export function uninstall() {
    const ctrl = controls();
    if (!_ourBox) return;

    if (ctrl) {
        const adj    = _ourBox._scrollAdjustment;
        const monIdx = _ourBox._monitorIndex;
        const fresh  = new WorkspaceThumbnail.ThumbnailsBox(adj, monIdx);

        ctrl.remove_child(_ourBox);
        ctrl.insert_child_at_index(fresh, _origIndex >= 0 ? _origIndex : -1);
        ctrl._thumbnailsBox = fresh;
        if (ctrl.layout_manager)
            ctrl.layout_manager._workspacesThumbnails = fresh;
        attachStandardSignals(fresh, ctrl);

        if (Main.overview.visible)
            fresh._createThumbnails();
    }

    _ourBox.destroy();
    _ourBox = null;
    _origBox = null;
    _origIndex = -1;
}
