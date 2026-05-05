// Высокоуровневые действия над топологией: переключение, создание, перемещение окна.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Navigator {
    constructor(topology, workspaceOps) {
        this._topology = topology;
        this._ops = workspaceOps;
        this._wm = global.workspace_manager;
    }

    _currentPos() {
        return this._topology.positionOf(this._wm.get_active_workspace_index());
    }

    _activate(wsIdx) {
        const ws = this._wm.get_workspace_by_index(wsIdx);
        if (ws) ws.activate(global.get_current_time());
    }

    _step(dir) {
        const pos = this._currentPos();
        if (!pos) return;
        const target = this._topology.neighbor(pos, dir);
        if (!target) return;
        const idx = this._topology.indexAt(target.col, target.layer);
        if (idx !== null) this._activate(idx);
    }

    switchUp()    { this._step('up'); }
    switchDown()  { this._step('down'); }
    switchLeft()  { this._step('left'); }
    switchRight() { this._step('right'); }

    _createAt(dir) {
        const pos = this._currentPos();
        if (!pos) return;
        const idx = this._ops.create(pos.col, dir);
        if (idx !== null) this._activate(idx);
    }

    createUp()   { this._createAt('up'); }
    createDown() { this._createAt('down'); }

    extendRowRight() {
        const t = this._topology;
        if (!t) return;
        const newIdx = t.mainRowSize;
        // Mutter insertWorkspace расширяет линейный список перед отростками;
        // отростки сдвигаются вправо. topology.onWorkspaceAdded увеличит mainRowSize.
        Main.wm.insertWorkspace(newIdx);
        const ws = this._wm.get_workspace_by_index(newIdx);
        if (ws) ws.activate(global.get_current_time());
    }

    _moveWindow(dir) {
        const win = global.display.focus_window;
        if (!win) return;
        const pos = this._currentPos();
        if (!pos) return;
        const target = this._topology.neighbor(pos, dir);
        if (!target) return;
        let idx = this._topology.indexAt(target.col, target.layer);
        if (idx === null) {
            // Up/down к несуществующему слою — создаём отросток в этом направлении
            // и переезжаем туда. Для left/right соседняя main-колонка всегда есть,
            // если её нет — neighbor() уже вернул бы null.
            if (dir !== 'up' && dir !== 'down') return;
            idx = this._ops.create(target.col, dir);
            if (idx === null) return;
        }
        win.change_workspace_by_index(idx, false);
        this._activate(idx);
    }

    moveWindowUp()    { this._moveWindow('up'); }
    moveWindowDown()  { this._moveWindow('down'); }
    moveWindowLeft()  { this._moveWindow('left'); }
    moveWindowRight() { this._moveWindow('right'); }

    removeCurrent() {
        const pos = this._currentPos();
        if (!pos || pos.layer === 0) return; // главный ряд не удаляем
        const idx = this._wm.get_active_workspace_index();
        const mainIdx = this._topology.indexAt(pos.col, 0);
        if (mainIdx === null) return;

        // Окна с удаляемого отростка явно переносим на main колонки —
        // иначе Mutter рассыпет их на соседний по линейному индексу воркспейс.
        const ws = this._wm.get_workspace_by_index(idx);
        if (ws) {
            for (const w of ws.list_windows())
                w.change_workspace_by_index(mainIdx, false);
        }
        this._activate(mainIdx);
        this._ops.remove(idx);
    }
}
