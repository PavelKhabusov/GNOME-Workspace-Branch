// Авто-удаление пустых отростков. Native dynamic-workspaces у нас принудительно
// выключен (иначе Mutter трогает n_workspaces сам и ломает топологию), поэтому
// делаем cleanup вручную:
//   - на active-workspace-changed: если предыдущий активный был отростком и
//     остался пустым, удаляем.
//   - на window-removed на любом workspace: если он отросток + пустой + не
//     активный, удаляем.
// Главный ряд никогда не трогаем (политика расширения — не ломать индексы AMW).

import GLib from 'gi://GLib';

let _topology = null;
let _ops = null;
let _addedSig = 0;
let _removedSig = 0;
let _activeSig = 0;
let _prevActive = -1;
const _wsHandlers = new Map(); // Meta.Workspace → handler id

function tryRemove(ws) {
    if (!ws || !_topology || !_ops) return;
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
            if (!ws.list_windows || ws.list_windows().length > 0)
                return GLib.SOURCE_REMOVE;
            const idx = ws.index();
            if (idx < _topology.mainRowSize) return GLib.SOURCE_REMOVE;
            const wm = global.workspace_manager;
            if (idx === wm.get_active_workspace_index()) return GLib.SOURCE_REMOVE;
            _ops.remove(idx);
        } catch (e) {
            // ws мог быть уже уничтожен между idle_add и нашим вызовом
        }
        return GLib.SOURCE_REMOVE;
    });
}

function attachWs(ws) {
    if (_wsHandlers.has(ws)) return;
    const id = ws.connect('window-removed', () => tryRemove(ws));
    _wsHandlers.set(ws, id);
}

function detachWs(ws) {
    const id = _wsHandlers.get(ws);
    if (id == null) return;
    try { ws.disconnect(id); } catch {}
    _wsHandlers.delete(ws);
}

function rescan() {
    const wm = global.workspace_manager;
    const live = new Set();
    for (let i = 0; i < wm.n_workspaces; i++) {
        const ws = wm.get_workspace_by_index(i);
        if (!ws) continue;
        live.add(ws);
        attachWs(ws);
    }
    for (const ws of [..._wsHandlers.keys()])
        if (!live.has(ws)) detachWs(ws);
}

function onActiveChanged() {
    const wm = global.workspace_manager;
    const idx = wm.get_active_workspace_index();
    if (_prevActive >= 0 && _prevActive !== idx) {
        const prev = wm.get_workspace_by_index(_prevActive);
        if (prev) tryRemove(prev);
    }
    _prevActive = idx;
}

export function install(topology, ops) {
    _topology = topology;
    _ops = ops;
    const wm = global.workspace_manager;
    _prevActive = wm.get_active_workspace_index();
    _addedSig   = wm.connect('workspace-added',   () => rescan());
    _removedSig = wm.connect('workspace-removed', () => rescan());
    _activeSig  = wm.connect('active-workspace-changed', onActiveChanged);
    rescan();
}

export function uninstall() {
    const wm = global.workspace_manager;
    if (_addedSig)   { wm.disconnect(_addedSig);   _addedSig = 0; }
    if (_removedSig) { wm.disconnect(_removedSig); _removedSig = 0; }
    if (_activeSig)  { wm.disconnect(_activeSig);  _activeSig = 0; }
    for (const ws of [..._wsHandlers.keys()]) detachWs(ws);
    _topology = null;
    _ops = null;
    _prevActive = -1;
}
