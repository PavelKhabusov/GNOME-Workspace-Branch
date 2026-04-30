import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Мини-карта: сетка ячеек, каждая колонка главного ряда — столбец,
// отростки сверху/снизу — соответствующие ячейки выше/ниже main.
// Активный воркспейс — заливка, существующий — полупрозрачный, пустой — едва видный.

const CELL = 4;       // сторона ячейки в px (компактнее, чтобы помещалось в панель)
const GAP = 1;        // зазор между ячейками
const MAX_LAYERS_VISIBLE = 2; // сверху и снизу показываем не больше N слоёв
const MAIN_ALPHA = 0.18;
const APP_ALPHA  = 0.55;

export const Indicator = GObject.registerClass(
class WorkspaceBranchIndicator extends PanelMenu.Button {
    _init(topology) {
        super._init(0.0, 'GNOME Workspace Branch', false);
        this._topology = topology;
        this._wm = global.workspace_manager;

        this._box = new St.BoxLayout({
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
            style: 'padding: 0 6px;',
        });
        this.add_child(this._box);

        this._activeId  = this._wm.connect('active-workspace-changed', () => this._render());
        this._addedId   = this._wm.connect('workspace-added',          () => this._render());
        this._removedId = this._wm.connect('workspace-removed',        () => this._render());

        // Меню строим лениво при каждом открытии — нет смысла держать в памяти
        // десяток PopupMenuItem-ов и перерисовывать на каждый switch.
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) this._buildMenu();
        });

        this._render();
    }

    _buildMenu() {
        this.menu.removeAll();
        const t = this._topology;
        const total = this._wm.n_workspaces;
        const activeIdx = this._wm.get_active_workspace_index();
        if (total === 0) return;

        const mainHeader = new PopupMenu.PopupMenuItem('Main row', { reactive: false });
        mainHeader.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(mainHeader);
        for (let i = 0; i < t.mainRowSize; i++)
            this.menu.addMenuItem(this._wsItem(i, `Workspace ${i + 1}`, i === activeIdx));

        const apCount = total - t.mainRowSize;
        if (apCount > 0) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const apHeader = new PopupMenu.PopupMenuItem('Appendages', { reactive: false });
            apHeader.label.style = 'font-weight: bold;';
            this.menu.addMenuItem(apHeader);
            for (let i = t.mainRowSize; i < total; i++) {
                const pos = t.positionOf(i);
                const label = pos
                    ? `Col ${pos.col + 1} ${pos.layer < 0 ? '↑' : '↓'}${Math.abs(pos.layer)}`
                    : `Workspace ${i + 1}`;
                this.menu.addMenuItem(this._wsItem(i, label, i === activeIdx));
            }
        }
    }

    _wsItem(wsIdx, label, active) {
        const item = new PopupMenu.PopupMenuItem(label);
        if (active)
            item.setOrnament(PopupMenu.Ornament.DOT);
        item.connect('activate', () => {
            const ws = this._wm.get_workspace_by_index(wsIdx);
            if (ws) ws.activate(global.get_current_time());
        });
        return item;
    }

    _render() {
        this._box.destroy_all_children();
        const t = this._topology;
        const cols = t.mainRowSize;
        if (cols === 0) return;

        // Глубина отростков по каждой колонке (clamp до MAX_LAYERS_VISIBLE
        // чтобы индикатор не вылезал за высоту панели).
        let maxUp = 0, maxDown = 0;
        for (let c = 0; c < cols; c++) {
            for (let l = -1; t.indexAt(c, l) !== null; l--)
                if (-l > maxUp) maxUp = -l;
            for (let l = 1; t.indexAt(c, l) !== null; l++)
                if (l > maxDown) maxDown = l;
        }
        maxUp = Math.min(maxUp, MAX_LAYERS_VISIBLE);
        maxDown = Math.min(maxDown, MAX_LAYERS_VISIBLE);

        const activeIdx = this._wm.get_active_workspace_index();
        const active = t.positionOf(activeIdx);

        const layers = [];
        for (let l = -maxUp; l <= maxDown; l++) layers.push(l);

        for (const layer of layers) {
            const row = new St.BoxLayout({ vertical: false });
            for (let c = 0; c < cols; c++) {
                const exists = layer === 0 ? true : t.indexAt(c, layer) !== null;
                const isActive = !!active && active.col === c && active.layer === layer;
                row.add_child(this._cell(exists, isActive, layer === 0));
            }
            this._box.add_child(row);
        }
    }

    _cell(exists, active, isMain) {
        let bg;
        if (active)      bg = 'rgba(255,255,255,0.95)';
        else if (exists) bg = `rgba(255,255,255,${APP_ALPHA})`;
        else if (isMain) bg = `rgba(255,255,255,${MAIN_ALPHA})`;
        else             bg = 'transparent';
        return new St.Widget({
            width: CELL, height: CELL,
            style: `background-color: ${bg}; border-radius: 1px; margin: ${GAP}px;`,
        });
    }

    destroy() {
        if (this._activeId)  { this._wm.disconnect(this._activeId);  this._activeId = null; }
        if (this._addedId)   { this._wm.disconnect(this._addedId);   this._addedId = null; }
        if (this._removedId) { this._wm.disconnect(this._removedId); this._removedId = null; }
        super.destroy();
    }
});
