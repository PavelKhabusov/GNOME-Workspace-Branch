// Высокоуровневые действия над топологией: переключение, создание, перемещение окна.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Navigator {
    constructor(topology, workspaceOps, settings = null) {
        this._topology = topology;
        this._ops = workspaceOps;
        this._settings = settings;
        this._wm = global.workspace_manager;
    }

    _drumMode() {
        return !!(this._settings && this._settings.get_boolean('drum-rotation'));
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

    switchUp() {
        if (!this._drumMode()) { this._step('up'); return; }
        const pos = this._currentPos();
        if (!pos) return;
        this._ops.rotateColumn(pos.col, 'up');
        // Drum-режим: активный всегда в main row. После вращения садим юзера
        // на главный текущей колонки (по индексу = col).
        this._activate(pos.col);
    }

    switchDown() {
        if (!this._drumMode()) { this._step('down'); return; }
        const pos = this._currentPos();
        if (!pos) return;
        this._ops.rotateColumn(pos.col, 'down');
        this._activate(pos.col);
    }

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

    // Вставить пустую колонку СЛЕВА от текущей. Текущая (и всё правее) едет
    // вправо; window-rules переиндексируются на +1. Фокус — на новую колонку.
    extendRowLeft() {
        this._insertColumnAt(this._currentColumn());
    }

    // Колонка текущего активного воркспейса (для отростка — его базовая колонка).
    _currentColumn() {
        const pos = this._currentPos();
        return pos ? pos.col : 0;
    }

    // Общая механика вставки колонки в позицию `at`. Переиндексацию правил
    // делает сам ops.insertMainColumn — здесь только активируем новую колонку.
    _insertColumnAt(at) {
        const idx = this._ops.insertMainColumn(at);
        if (idx === null) return null;
        this._activate(idx);
        return idx;
    }

    _moveWindow(dir) {
        const win = global.display.focus_window;
        if (!win) return;
        const pos = this._currentPos();
        if (!pos) return;

        const target = this._topology.neighbor(pos, dir);
        if (!target) {
            // Нет соседа в этом направлении. Для left/right это значит край
            // главного ряда — отделяем окно в новую колонку (move-with-create).
            // Только если в текущем воркспейсе есть ДРУГИЕ окна: если окно тут
            // одно, оно уже крайнее, а новая пустая колонка была бы тут же
            // снесена auto-cleanup (окно вернулось бы назад) — это no-op.
            if (pos.layer !== 0) return;
            const t = this._topology;
            const curIdx = this._wm.get_active_workspace_index();
            const curWs = this._wm.get_workspace_by_index(curIdx);
            const others = curWs
                ? curWs.list_windows().filter(w => w !== win).length : 0;
            if (others === 0) return;

            if (dir === 'left' && pos.col === 0) {
                // Вставляем колонку слева: всё едет вправо, окно уезжает в
                // новую col=0. window-rules при этом не трогаем — они
                // принадлежат пользователю.
                const idx = this._insertColumnAt(0);
                if (idx === null) return;
                win.change_workspace_by_index(idx, false);
                this._activate(idx);
            } else if (dir === 'right' && pos.col === t.mainRowSize - 1) {
                // Расширяем ряд справа: новая колонка в конце, окно туда.
                const idx = this._ops.insertMainColumn(t.mainRowSize);
                if (idx === null) return;
                win.change_workspace_by_index(idx, false);
                this._activate(idx);
            }
            return;
        }

        let idx = this._topology.indexAt(target.col, target.layer);
        if (idx === null) {
            // Up/down к несуществующему слою — создаём отросток в этом направлении
            // и переезжаем туда.
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
