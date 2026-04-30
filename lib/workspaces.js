// CRUD отростков. Регистрация в Topology выполняется ДО соответствующего
// вызова Mutter, чтобы signal-handler видел согласованное состояние и не
// дублировал работу.

export class WorkspaceOps {
    constructor(topology) {
        this._topology = topology;
        this._wm = global.workspace_manager;
    }

    // Создать отросток для колонки. Возвращает линейный индекс или null.
    create(col, dir) {
        if (col < 0 || col >= this._topology.mainRowSize) return null;
        if (dir !== 'up' && dir !== 'down') return null;
        const idx = this._topology.registerAppendage(col, dir);
        this._wm.append_new_workspace(false, global.get_current_time());
        return idx;
    }

    // Удалить произвольный отросток по линейному индексу.
    remove(wsIdx) {
        if (wsIdx < this._topology.mainRowSize) return false;
        const ws = this._wm.get_workspace_by_index(wsIdx);
        if (!ws) return false;
        this._topology.unregisterAt(wsIdx);
        this._wm.remove_workspace(ws, global.get_current_time());
        return true;
    }
}
