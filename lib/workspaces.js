// CRUD отростков. Регистрация в Topology выполняется ДО соответствующего
// вызова Mutter, чтобы signal-handler видел согласованное состояние и не
// дублировал работу.
//
// Инвариант: этот слой НИКОГДА не пишет в window-rules. Правила принадлежат
// пользователю; топология под них подстраивается, а не наоборот.

export class WorkspaceOps {
    constructor(topology) {
        this._topology = topology;
        this._wm = global.workspace_manager;
    }

    // Расширяет главный ряд до тех пор, пока mainRowSize > col.
    //
    // Mutter не умеет «вставить воркспейс по индексу» — только append в конец.
    // Поэтому: append_new_workspace кладёт ws на самый последний линейный idx;
    // topology.onWorkspaceAdded синхронно увеличит mainRowSize. Затем мы
    // reorder_workspace переносим этот ws на позицию (mainRowSize − 1) — он
    // встанет последним в main-ряд, перед существующими appendages.
    //
    // Прим.: Main.wm.insertWorkspace не подходит — он no-op, когда mutter в
    // static-режиме (dynamic-workspaces=false), а мы именно в этом режиме.
    extendMainRowTo(col) {
        if (typeof col !== 'number' || col < 0) return;
        let safety = 32;
        while (this._topology.mainRowSize <= col && safety-- > 0) {
            this._wm.append_new_workspace(false, global.get_current_time());
            const lastIdx = this._wm.n_workspaces - 1;
            const targetIdx = this._topology.mainRowSize - 1;
            if (lastIdx !== targetIdx) {
                const ws = this._wm.get_workspace_by_index(lastIdx);
                if (ws) this._wm.reorder_workspace(ws, targetIdx);
            }
        }
    }

    // Вставить пустую колонку в главный ряд на позицию `at` (0..mainRowSize).
    // Колонки справа сдвигаются вправо (переиндексация в topology). Возвращает
    // линейный индекс новой колонки (= at) или null.
    //
    // Mutter умеет только append. Регистрируем вставку в topology ДО append,
    // чтобы onWorkspaceAdded видел согласованное n_workspaces == expected и не
    // трогал mainRowSize. Затем reorder переносит свежий ws с последнего
    // линейного индекса на позицию `at` — отростки при этом сдвигаются вправо.
    insertMainColumn(at) {
        const t = this._topology;
        if (typeof at !== 'number' || at < 0 || at > t.mainRowSize) return null;
        if (!t.insertMainColumn(at)) return null;
        this._wm.append_new_workspace(false, global.get_current_time());
        const lastIdx = this._wm.n_workspaces - 1;
        if (lastIdx !== at) {
            const ws = this._wm.get_workspace_by_index(lastIdx);
            if (ws) this._wm.reorder_workspace(ws, at);
        }
        return at;
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

    // Удалить колонку из главного ряда. Topology переиндексирует оставшиеся
    // отростки (cols > removed). На колонке не должно быть отростков.
    //
    // window-rules НЕ трогаем: правила — это декларация желаемой раскладки,
    // которую редактирует только пользователь. Раньше здесь стоял
    // reindexColumns(idx, -1), и он переписывал target.col у правил на каждое
    // удаление колонки — в т.ч. при логауте, когда окна закрываются пачкой и
    // auto-cleanup схлопывает главный ряд. Конфиг «уезжал влево» и следующая
    // сессия поднималась по испорченным правилам.
    removeMainColumn(idx) {
        if (idx < 0 || idx >= this._topology.mainRowSize) return false;
        const ws = this._wm.get_workspace_by_index(idx);
        if (!ws) return false;
        if (!this._topology.removeMainColumn(idx)) return false;
        this._wm.remove_workspace(ws, global.get_current_time());
        return true;
    }

    // Drum rotation: вращает «барабан» колонки `col`. Все её слои сдвигаются
    // на ±1; ws с layer +1 (или -1) выезжает на main, остальные едут следом.
    // Mutter переиндексируется, topology._appendages перестраивается.
    // Возвращает true, если вращение применилось.
    rotateColumn(col, direction) {
        const t = this._topology;
        const plan = t.computeRotation(col, direction);
        if (!plan) return false;

        const N = t.mainRowSize + t.appendageCount;
        // Снимок текущих ws по линейному индексу — после _setAppendages
        // топология уже описывает НОВОЕ состояние, поэтому ws нужно подцепить ДО.
        const wsByOldIdx = [];
        for (let i = 0; i < N; i++) {
            const ws = this._wm.get_workspace_by_index(i);
            if (!ws) return false;
            wsByOldIdx.push(ws);
        }

        t._setAppendages(plan.newAppendages);

        // newLinearOf[oldIdx] = targetIdx. Идём по target'ам слева направо
        // и подтягиваем нужный ws на место — уже размещённые слева не сдвигаются,
        // т.к. reorder задевает только воркспейсы между source и target.
        for (let target = 0; target < N; target++) {
            const cur = this._wm.get_workspace_by_index(target);
            // Какой ws должен быть на этом target?
            let desired = null;
            for (let oldIdx = 0; oldIdx < N; oldIdx++) {
                if (plan.newLinearOf[oldIdx] === target) {
                    desired = wsByOldIdx[oldIdx];
                    break;
                }
            }
            if (!desired || cur === desired) continue;
            this._wm.reorder_workspace(desired, target);
        }

        return true;
    }
}
