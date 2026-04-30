// Topology — single source of truth для отростков.
//
// Линейный список Mutter: [main_0, main_1, ..., main_{N-1}, app_0, app_1, ...]
// где app_i описан в this._appendages[i] = {col, dir}.
// Воркспейс с линейным индексом (mainRowSize + i) — это i-й отросток.
//
// Это даёт изоморфизм с порядком Mutter: при splice массива и remove_workspace
// в Mutter индексы остаются согласованы автоматически — ничего сдвигать вручную.

export class Topology {
    constructor(settings) {
        this._settings = settings;
        this._appendages = [];
        this._mainRowSize = 0;
        this._wm = global.workspace_manager;
    }

    load() {
        const total = this._wm.n_workspaces;
        let stored;
        try {
            stored = JSON.parse(this._settings.get_string('appendages'));
            if (!Array.isArray(stored)) stored = [];
        } catch {
            stored = [];
        }
        stored = stored.filter(Topology._isValidEntry);
        const storedMain = this._settings.get_int('main-row-size');

        // Полное соответствие: восстанавливаем как было.
        if (storedMain > 0 && total === storedMain + stored.length) {
            this._mainRowSize = storedMain;
            this._appendages = stored;
            return;
        }

        // Свежая сессия (Wayland reboot): main совпадает, отростков нет.
        // Запоминаем — extension.js потом дозальёт недостающие.
        if (storedMain > 0 && total === storedMain) {
            this._mainRowSize = storedMain;
            this._appendages = stored;
            return;
        }

        // Главный ряд расширили снаружи — отростки сохраняем, main растягиваем.
        if (storedMain > 0 && total > storedMain + stored.length) {
            this._mainRowSize = total - stored.length;
            this._appendages = stored;
            this._save();
            return;
        }

        // Фолбэк: всё считаем главным рядом.
        this._mainRowSize = total;
        this._appendages = [];
        this._save();
    }

    static _isValidEntry(e) {
        return e
            && typeof e.col === 'number'
            && Number.isInteger(e.col)
            && e.col >= 0
            && (e.dir === 'up' || e.dir === 'down');
    }

    _save() {
        this._settings.set_string('appendages', JSON.stringify(this._appendages));
        this._settings.set_int('main-row-size', this._mainRowSize);
    }

    get mainRowSize() {
        return this._mainRowSize;
    }

    get appendageCount() {
        return this._appendages.length;
    }

    // {col, layer} | null. layer: 0=main, <0=up, >0=down.
    positionOf(wsIdx) {
        if (wsIdx < 0) return null;
        if (wsIdx < this._mainRowSize) return { col: wsIdx, layer: 0 };
        const i = wsIdx - this._mainRowSize;
        const ap = this._appendages[i];
        if (!ap) return null;
        let depth = 0;
        for (let k = 0; k <= i; k++) {
            const e = this._appendages[k];
            if (e.col === ap.col && e.dir === ap.dir) depth++;
        }
        return { col: ap.col, layer: ap.dir === 'up' ? -depth : depth };
    }

    indexAt(col, layer) {
        if (layer === 0) {
            return (col >= 0 && col < this._mainRowSize) ? col : null;
        }
        const dir = layer < 0 ? 'up' : 'down';
        const target = Math.abs(layer);
        let depth = 0;
        for (let i = 0; i < this._appendages.length; i++) {
            const e = this._appendages[i];
            if (e.col === col && e.dir === dir) {
                depth++;
                if (depth === target) return this._mainRowSize + i;
            }
        }
        return null;
    }

    // Регистрирует новый отросток ДО append_new_workspace в Mutter.
    // Возвращает линейный индекс, по которому он будет создан.
    registerAppendage(col, dir) {
        this._appendages.push({ col, dir });
        this._save();
        return this._mainRowSize + this._appendages.length - 1;
    }

    // Снимает регистрацию ДО remove_workspace.
    unregisterAt(wsIdx) {
        const i = wsIdx - this._mainRowSize;
        if (i < 0 || i >= this._appendages.length) return false;
        this._appendages.splice(i, 1);
        this._save();
        return true;
    }

    onWorkspaceAdded(addedIdx) {
        const total = this._wm.n_workspaces;
        const expected = this._mainRowSize + this._appendages.length;
        if (total === expected) return; // наш registerAppendage уже учёл
        // Внешнее добавление: считаем расширением главного ряда.
        // (Если воткнули в середину отростков — консервативно тоже растим main.)
        if (addedIdx < this._mainRowSize) {
            this._mainRowSize += 1;
        } else {
            this._mainRowSize = total - this._appendages.length;
        }
        this._save();
    }

    onWorkspaceRemoved(removedIdx) {
        const total = this._wm.n_workspaces;
        const expected = this._mainRowSize + this._appendages.length;
        if (total === expected) return; // наш unregisterAt уже учёл
        if (removedIdx < this._mainRowSize) {
            this._mainRowSize = Math.max(0, this._mainRowSize - 1);
        } else {
            const i = removedIdx - this._mainRowSize;
            if (i >= 0 && i < this._appendages.length) {
                this._appendages.splice(i, 1);
            }
        }
        // Если после правок всё равно расходится — доверяем Mutter.
        const newExpected = this._mainRowSize + this._appendages.length;
        if (total !== newExpected) {
            this._mainRowSize = total;
            this._appendages = [];
        }
        this._save();
    }

    // Вариант A: left/right в отростке снапается на main соседней колонки.
    neighbor(pos, dir) {
        if (!pos) return null;
        const { col, layer } = pos;
        switch (dir) {
            case 'left':
                return col > 0 ? { col: col - 1, layer: 0 } : null;
            case 'right':
                return col < this._mainRowSize - 1 ? { col: col + 1, layer: 0 } : null;
            case 'up':
                return { col, layer: layer - 1 };
            case 'down':
                return { col, layer: layer + 1 };
        }
        return null;
    }

    snapshot() {
        return {
            mainRowSize: this._mainRowSize,
            appendages: this._appendages.map(e => ({ ...e })),
        };
    }
}
