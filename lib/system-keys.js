import Gio from 'gi://Gio';

// Системные ключи, чьи значения по дефолту пересекаются с типичными
// настройками нашего расширения. Снимаем только пересекающиеся accel-ы,
// остальные оставляем нетронутыми. На disable возвращаем как было.

const WM = 'org.gnome.desktop.wm.keybindings';

const POTENTIAL_CONFLICTS = [
    [WM, 'unmaximize'],                   // <Super>Down
    [WM, 'maximize'],                     // <Super>Up (в части дистрибутивов)
    [WM, 'move-to-monitor-up'],           // <Super><Shift>Up
    [WM, 'move-to-monitor-down'],         // <Super><Shift>Down
    [WM, 'move-to-monitor-left'],         // <Super><Shift>Left
    [WM, 'move-to-monitor-right'],        // <Super><Shift>Right
    [WM, 'move-to-workspace-up'],         // <Super><Ctrl>Up
    [WM, 'move-to-workspace-down'],
    [WM, 'move-to-workspace-left'],       // <Super><Shift>Left в части конфигов
    [WM, 'move-to-workspace-right'],
    [WM, 'switch-to-workspace-left'],     // <Super>Left
    [WM, 'switch-to-workspace-right'],    // <Super>Right
];

export class SystemKeys {
    constructor(ourSettings, ourKeyNames) {
        this._our = ourSettings;
        this._ourKeys = ourKeyNames;
        this._saved = [];
        this._schemas = new Map();
    }

    _schema(id) {
        if (this._schemas.has(id)) return this._schemas.get(id);
        try {
            const s = new Gio.Settings({ schema_id: id });
            this._schemas.set(id, s);
            return s;
        } catch (e) {
            console.warn(`[workspace-branch] schema ${id} not available: ${e.message}`);
            this._schemas.set(id, null);
            return null;
        }
    }

    _gatherOurAccels() {
        const out = new Set();
        for (const k of this._ourKeys) {
            for (const a of this._our.get_strv(k))
                if (a) out.add(a);
        }
        return out;
    }

    install() {
        const ours = this._gatherOurAccels();
        if (ours.size === 0) return;
        for (const [schemaId, key] of POTENTIAL_CONFLICTS) {
            const s = this._schema(schemaId);
            if (!s) continue;
            const cur = s.get_strv(key);
            const stripped = cur.filter(a => !ours.has(a));
            if (stripped.length === cur.length) continue; // нет пересечения
            this._saved.push({ schemaId, key, value: cur });
            s.set_strv(key, stripped);
            console.log(`[workspace-branch] released ${schemaId}.${key}: ${cur.join(',')} -> ${stripped.join(',') || '(empty)'}`);
        }
    }

    restore() {
        for (const { schemaId, key, value } of this._saved) {
            const s = this._schema(schemaId);
            if (!s) continue;
            s.set_strv(key, value);
        }
        this._saved = [];
        this._schemas.clear();
    }
}
