// Замена WorkspacesView (большой actor с workspace previews в overview) на
// собственный subclass, который раскладывает workspaces в 2D по нашей topology.
//
// Подход тот же, что с GridThumbnailsBox: создаём подкласс через
// GObject.registerClass — для нового GType работает override vfunc_allocate.
// Затем patch'им WorkspacesDisplay._updateWorkspacesViews чтобы для primary
// monitor создавал наш subclass.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WSV from 'resource:///org/gnome/shell/ui/workspacesView.js';

let _topology = null;
let _origUpdate = null;
let _display = null;

function layerExtents(t) {
    let maxUp = 0, maxDown = 0;
    for (let c = 0; c < t.mainRowSize; c++) {
        for (let l = -1; t.indexAt(c, l) !== null; l--)
            if (-l > maxUp) maxUp = -l;
        for (let l = 1; t.indexAt(c, l) !== null; l++)
            if (l > maxDown) maxDown = l;
    }
    return { maxUp, maxDown };
}

function monitorRatio(view) {
    const m = Main.layoutManager.monitors[view._monitorIndex];
    return m && m.height > 0 ? m.width / m.height : 16 / 9;
}

const GridWorkspacesView = GObject.registerClass(
class GridWorkspacesView extends WSV.WorkspacesView {
    _init(...args) {
        super._init(...args);
        // Соседи в 2D могут overflow за allocation — клипим, чтобы не
        // перекрывать dock и search bar.
        this.clip_to_allocation = true;
    }

    vfunc_allocate(box) {
        const t = _topology;
        if (!t || t.mainRowSize === 0 || this._workspaces.length === 0) {
            super.vfunc_allocate(box);
            return;
        }

        this.set_allocation(box);

        const fitMode = this._fitModeAdjustment.value;
        const allWeight = Math.max(0, Math.min(1, fitMode));
        const [width, height] = box.get_size();
        const ratio = monitorRatio(this);

        const cols = t.mainRowSize;
        const { maxUp, maxDown } = layerExtents(t);
        const rows = 1 + maxUp + maxDown;

        // === ALL params (compact 2D grid centered) ===
        const spacingAll = 16;
        const cellW = (width  - (cols + 1) * spacingAll) / cols;
        const cellH = (height - (rows + 1) * spacingAll) / rows;
        let allW = cellW, allH = cellH;
        if (allW / allH > ratio) allW = allH * ratio;
        else                     allH = allW / ratio;
        const allTotalW = cols * allW + (cols - 1) * spacingAll;
        const allTotalH = rows * allH + (rows - 1) * spacingAll;
        const allBaseX = (width - allTotalW) / 2;
        const allBaseY = (height - allTotalH) / 2 + maxUp * (allH + spacingAll);

        // === SINGLE params (большой active workspace в центре) ===
        const margin = 0.85;
        let singleW = width * margin;
        let singleH = singleW / ratio;
        if (singleH > height * margin) {
            singleH = height * margin;
            singleW = singleH * ratio;
        }
        const spacingSingle = Math.round(singleW * 0.06);

        // pivot — где центр SINGLE-сетки. Берётся по scrollAdjustment.value
        // (плавно меняется при native horizontal swipe).
        const adjValue = this._scrollAdjustment.value;
        const lo = Math.floor(adjValue);
        const hi = Math.ceil(adjValue);
        const frac = adjValue - lo;
        const pLo = t.positionOf(lo) ?? t.positionOf(0) ?? { col: 0, layer: 0 };
        const pHi = t.positionOf(hi) ?? pLo;
        const pivotCol   = pLo.col   + (pHi.col   - pLo.col)   * frac;
        const pivotLayer = pLo.layer + (pHi.layer - pLo.layer) * frac;
        const singleBaseX = width / 2 - singleW / 2 - pivotCol   * (singleW + spacingSingle);
        const singleBaseY = height / 2 - singleH / 2 - pivotLayer * (singleH + spacingSingle);

        const childBox = new Clutter.ActorBox();
        for (let i = 0; i < this._workspaces.length; i++) {
            const child = this._workspaces[i];
            const pos = t.positionOf(i);
            if (!pos) {
                childBox.set_origin(-100000, 0);
                childBox.set_size(allW, allH);
                child.allocate_align_fill(childBox, 0.5, 0.5, false, false);
                continue;
            }

            // Lerp между SINGLE и ALL по fitMode
            const singleX = singleBaseX + pos.col   * (singleW + spacingSingle);
            const singleY = singleBaseY + pos.layer * (singleH + spacingSingle);
            const allX    = allBaseX    + pos.col   * (allW    + spacingAll);
            const allY    = allBaseY    + pos.layer * (allH    + spacingAll);

            const x = singleX + (allX - singleX) * allWeight;
            const y = singleY + (allY - singleY) * allWeight;
            const w = singleW + (allW - singleW) * allWeight;
            const h = singleH + (allH - singleH) * allWeight;

            childBox.set_origin(x, y);
            childBox.set_size(w, h);
            child.allocate_align_fill(childBox, 0.5, 0.5, false, false);
        }
    }
});

function patchedUpdateWorkspacesViews() {
    for (let i = 0; i < this._workspacesViews.length; i++)
        this._workspacesViews[i].destroy();

    this._primaryIndex = Main.layoutManager.primaryIndex;
    this._workspacesViews = [];
    const monitors = Main.layoutManager.monitors;
    for (let i = 0; i < monitors.length; i++) {
        let view;
        if (i === this._primaryIndex) {
            view = new GridWorkspacesView(i,
                this._controls,
                this._scrollAdjustment,
                this._fitModeAdjustment,
                this._overviewAdjustment);
            view.visible = this._primaryVisible;
            this.bind_property('opacity', view, 'opacity', GObject.BindingFlags.SYNC_CREATE);
            this.add_child(view);
        } else {
            view = new WSV.SecondaryMonitorDisplay(i,
                this._controls,
                this._scrollAdjustment,
                this._fitModeAdjustment,
                this._overviewAdjustment);
            Main.layoutManager.overviewGroup.add_child(view);
        }
        this._workspacesViews.push(view);
    }
}

export function install(topology) {
    _topology = topology;
    _display = Main.overview?._overview?._controls?._workspacesDisplay;
    if (!_display) {
        console.warn('[workspace-branch] _workspacesDisplay not available');
        return;
    }
    if (_origUpdate) return;
    _origUpdate = WSV.WorkspacesDisplay.prototype._updateWorkspacesViews;
    WSV.WorkspacesDisplay.prototype._updateWorkspacesViews = patchedUpdateWorkspacesViews;
    _display._updateWorkspacesViews(); // пересоздать views с GridWorkspacesView для primary
    console.log('[workspace-branch] WorkspacesView swapped to Grid version');
}

export function uninstall() {
    if (_origUpdate) {
        WSV.WorkspacesDisplay.prototype._updateWorkspacesViews = _origUpdate;
        _origUpdate = null;
    }
    if (_display) {
        try { _display._updateWorkspacesViews(); } catch {}
    }
    _display = null;
    _topology = null;
}
