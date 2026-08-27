#!/usr/bin/env -S gjs -m
// Standalone unit tests для Topology. Запуск: gjs -m tests/topology-test.js
// Топология самодостаточна — global.workspace_manager и Gio.Settings мокаем.

import { Topology } from '../lib/topology.js';

// --- mocks ---

class FakeSettings {
    constructor(initial = {}) { this._s = { ...initial }; }
    get_string(k) { return this._s[k] ?? '"[]"'; }
    set_string(k, v) { this._s[k] = v; }
    get_int(k) { return this._s[k] ?? 0; }
    set_int(k, v) { this._s[k] = v; }
    snapshot() { return { ...this._s }; }
}

class FakeWM {
    constructor(n) { this.n_workspaces = n; }
}

// Topology читает global.workspace_manager в конструкторе.
globalThis.global = { workspace_manager: null };

function withWM(n, fn) {
    globalThis.global.workspace_manager = new FakeWM(n);
    try { return fn(globalThis.global.workspace_manager); }
    finally { globalThis.global.workspace_manager = null; }
}

// --- tiny test harness ---
let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); print(`  ok  ${name}`); passed++; }
    catch (e) { print(`  FAIL ${name}\n       ${e.message}\n${e.stack}`); failed++; }
}
function eq(a, b, msg = '') {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error(`${msg} expected ${B}, got ${A}`);
}
function isNull(v, msg = '') {
    if (v !== null) throw new Error(`${msg} expected null, got ${JSON.stringify(v)}`);
}

// --- tests ---

print('Topology.load — fresh start (storedMain=0)');
test('all workspaces become main row', () => {
    withWM(4, () => {
        const t = new Topology(new FakeSettings());
        t.load();
        eq(t.mainRowSize, 4);
        eq(t.appendageCount, 0);
    });
});

print('\nTopology.load — full match (main + appendages)');
test('restores stored topology', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":2,"dir":"up"},{"col":2,"dir":"up"},{"col":3,"dir":"down"}]',
        'main-row-size': 4,
    });
    withWM(7, () => {
        const t = new Topology(s);
        t.load();
        eq(t.mainRowSize, 4);
        eq(t.appendageCount, 3);
        eq(t.snapshot().appendages, [
            {col:2,dir:'up'}, {col:2,dir:'up'}, {col:3,dir:'down'}
        ]);
    });
});

print('\nTopology.load — Wayland reboot (main same, appendages lost)');
test('keeps appendages for restoration', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":2,"dir":"up"}]',
        'main-row-size': 4,
    });
    withWM(4, () => {
        const t = new Topology(s);
        t.load();
        eq(t.mainRowSize, 4);
        eq(t.appendageCount, 1, 'expects appendage to stay so extension.js can restore');
    });
});

print('\nTopology.load — main row extended externally');
test('grows mainRowSize to absorb extras', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":2,"dir":"up"}]',
        'main-row-size': 4,
    });
    withWM(6, () => {
        const t = new Topology(s);
        t.load();
        eq(t.mainRowSize, 5, 'main row absorbs 1 extra workspace');
        eq(t.appendageCount, 1);
    });
});

print('\nTopology.load — main row floor from window-rules');
// Регрессия: главный ряд не может быть уже, чем колонки, которые просят
// правила. Раньше auto-cleanup при логауте схлопывал main-row-size (и заодно
// сдвигал сами правила), и следующая сессия поднималась «на колонку левее».
// Теперь правила — источник истины, а mainRowSize под них растягивается.
const RULES_TO_COL_3 = JSON.stringify([
    { match: { desktop_id: 'telegram.desktop' }, target: { col: 0, layer: 0 } },
    { match: { desktop_id: 'helium.desktop' },   target: { col: 1, layer: 0 } },
    { match: { desktop_id: 'code.desktop' },     target: { col: 2, layer: 0 } },
    { match: { pid_comm: 'Unity' },              target: { col: 3, layer: 1 } },
]);

test('collapsed main-row-size is restored from rules', () => {
    // Состояние после «порчи»: main-row-size схлопнут до 2, воркспейсов 2.
    const s = new FakeSettings({
        'appendages': '[]',
        'main-row-size': 2,
        'window-rules': RULES_TO_COL_3,
    });
    withWM(2, () => {
        const t = new Topology(s); t.load();
        // Правила просят col 3 → ряд обязан быть шириной 4.
        eq(t.mainRowSize, 4);
        eq(t.appendageCount, 0);
        // И это сохранено — extension.js дольёт недостающие воркспейсы.
        eq(s.snapshot()['main-row-size'], 4);
    });
});

test('floor does not shrink a wider row', () => {
    const s = new FakeSettings({
        'appendages': '[]',
        'main-row-size': 6,
        'window-rules': RULES_TO_COL_3,
    });
    withWM(6, () => {
        const t = new Topology(s); t.load();
        eq(t.mainRowSize, 6);   // шире, чем просят правила — не трогаем
    });
});

test('floor keeps appendages intact', () => {
    const s = new FakeSettings({
        'appendages': JSON.stringify([{col:1,dir:'up'}, {col:1,dir:'up'}]),
        'main-row-size': 2,
        'window-rules': RULES_TO_COL_3,
    });
    withWM(4, () => {   // 2 main + 2 appendages
        const t = new Topology(s); t.load();
        eq(t.mainRowSize, 4);
        eq(t.appendageCount, 2);
        // Отростки по-прежнему висят на своей колонке.
        eq(t.positionOf(4), {col:1, layer:-1});
        eq(t.positionOf(5), {col:1, layer:-2});
    });
});

test('no rules → no floor', () => {
    const s = new FakeSettings({
        'appendages': '[]',
        'main-row-size': 2,
        'window-rules': '[]',
    });
    withWM(2, () => {
        const t = new Topology(s); t.load();
        eq(t.mainRowSize, 2);
    });
});

test('garbage rules are ignored by the floor', () => {
    const s = new FakeSettings({
        'appendages': '[]',
        'main-row-size': 2,
        'window-rules': JSON.stringify([
            { match: {}, target: { col: 99 } },      // сейф-лимит: игнор
            { match: {}, target: { col: -1 } },      // отрицательная: игнор
            { match: {}, target: { col: 'x' } },     // не число: игнор
            { match: {}, target: {} },               // нет col: игнор
        ]),
    });
    withWM(2, () => {
        const t = new Topology(s); t.load();
        eq(t.mainRowSize, 2);
    });
});

test('malformed window-rules JSON does not throw', () => {
    const s = new FakeSettings({
        'appendages': '[]',
        'main-row-size': 2,
        'window-rules': '{not json',
    });
    withWM(2, () => {
        const t = new Topology(s); t.load();
        eq(t.mainRowSize, 2);
    });
});

print('\nTopology.positionOf');
test('main row positions', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":2,"dir":"up"}]',
        'main-row-size': 4,
    });
    withWM(5, () => {
        const t = new Topology(s); t.load();
        eq(t.positionOf(0), {col:0, layer:0});
        eq(t.positionOf(3), {col:3, layer:0});
        eq(t.positionOf(4), {col:2, layer:-1});
    });
});

test('multi-layer up/down depth counting', () => {
    const s = new FakeSettings({
        'appendages': JSON.stringify([
            {col:2,dir:'up'},   // idx 4 → layer -1
            {col:2,dir:'up'},   // idx 5 → layer -2
            {col:2,dir:'down'}, // idx 6 → layer +1
            {col:3,dir:'up'},   // idx 7 → layer -1 (col 3)
            {col:2,dir:'up'},   // idx 8 → layer -3 (3-я up в col 2)
        ]),
        'main-row-size': 4,
    });
    withWM(9, () => {
        const t = new Topology(s); t.load();
        eq(t.positionOf(4), {col:2, layer:-1});
        eq(t.positionOf(5), {col:2, layer:-2});
        eq(t.positionOf(6), {col:2, layer:+1});
        eq(t.positionOf(7), {col:3, layer:-1});
        eq(t.positionOf(8), {col:2, layer:-3});
    });
});

print('\nTopology.indexAt');
test('round-trip with positionOf', () => {
    const s = new FakeSettings({
        'appendages': JSON.stringify([
            {col:2,dir:'up'}, {col:2,dir:'up'}, {col:3,dir:'down'},
        ]),
        'main-row-size': 4,
    });
    withWM(7, () => {
        const t = new Topology(s); t.load();
        for (let i = 0; i < 7; i++) {
            const p = t.positionOf(i);
            eq(t.indexAt(p.col, p.layer), i, `round-trip for idx ${i}`);
        }
        isNull(t.indexAt(2, -3), 'no third up in col 2');
        isNull(t.indexAt(0, -1), 'no up in col 0');
        isNull(t.indexAt(99, 0), 'col out of range');
    });
});

print('\nTopology.neighbor');
test('main row left/right', () => {
    const s = new FakeSettings({ 'main-row-size': 4 });
    withWM(4, () => {
        const t = new Topology(s); t.load();
        eq(t.neighbor({col:2,layer:0}, 'left'),  {col:1,layer:0});
        eq(t.neighbor({col:2,layer:0}, 'right'), {col:3,layer:0});
        isNull(t.neighbor({col:0,layer:0}, 'left'));
        isNull(t.neighbor({col:3,layer:0}, 'right'));
    });
});

test('up/down stepping', () => {
    const s = new FakeSettings({ 'main-row-size': 4 });
    withWM(4, () => {
        const t = new Topology(s); t.load();
        eq(t.neighbor({col:2,layer:0},  'up'),   {col:2,layer:-1});
        eq(t.neighbor({col:2,layer:-1}, 'up'),   {col:2,layer:-2});
        eq(t.neighbor({col:2,layer:-1}, 'down'), {col:2,layer:0});
        eq(t.neighbor({col:2,layer:1},  'up'),   {col:2,layer:0});
        eq(t.neighbor({col:2,layer:1},  'down'), {col:2,layer:2});
    });
});

test('variant A: left/right from appendage snaps to main of neighbor col', () => {
    const s = new FakeSettings({ 'main-row-size': 4 });
    withWM(4, () => {
        const t = new Topology(s); t.load();
        eq(t.neighbor({col:2,layer:-1}, 'left'),  {col:1,layer:0});
        eq(t.neighbor({col:2,layer:-2}, 'right'), {col:3,layer:0});
    });
});

print('\nTopology.registerAppendage / unregisterAt');
test('register pushes to end and returns new wsIdx', () => {
    const s = new FakeSettings({ 'main-row-size': 4 });
    withWM(4, () => {
        const t = new Topology(s); t.load();
        eq(t.registerAppendage(2, 'up'), 4);
        eq(t.registerAppendage(2, 'up'), 5);
        eq(t.registerAppendage(3, 'down'), 6);
        eq(t.appendageCount, 3);
    });
});

test('unregister removes by wsIdx and shifts later ones', () => {
    const s = new FakeSettings({
        'appendages': JSON.stringify([
            {col:2,dir:'up'}, {col:2,dir:'up'}, {col:3,dir:'down'},
        ]),
        'main-row-size': 4,
    });
    withWM(7, () => {
        const t = new Topology(s); t.load();
        eq(t.unregisterAt(5), true); // удалили layer=-2 в col 2
        eq(t.appendageCount, 2);
        // теперь idx 5 — это бывший {col:3,dir:'down'}
        eq(t.positionOf(5), {col:3, layer:1});
    });
});

print('\nTopology.onWorkspaceAdded / onWorkspaceRemoved');
test('handler is no-op when our register already accounted', () => {
    const s = new FakeSettings({ 'main-row-size': 4 });
    const wm = new FakeWM(4);
    globalThis.global.workspace_manager = wm;
    const t = new Topology(s); t.load();
    t.registerAppendage(2, 'up'); // _appendages.length = 1
    wm.n_workspaces = 5;          // имитация append_new_workspace
    t.onWorkspaceAdded(4);
    eq(t.mainRowSize, 4, 'should not grow main row');
    eq(t.appendageCount, 1);
    globalThis.global.workspace_manager = null;
});

test('external workspace-added grows mainRowSize', () => {
    const s = new FakeSettings({ 'main-row-size': 4 });
    const wm = new FakeWM(4);
    globalThis.global.workspace_manager = wm;
    const t = new Topology(s); t.load();
    wm.n_workspaces = 5;
    t.onWorkspaceAdded(4);
    eq(t.mainRowSize, 5);
    eq(t.appendageCount, 0);
    globalThis.global.workspace_manager = null;
});

test('external workspace-removed from main shrinks main row', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":2,"dir":"up"}]',
        'main-row-size': 4,
    });
    const wm = new FakeWM(5);
    globalThis.global.workspace_manager = wm;
    const t = new Topology(s); t.load();
    wm.n_workspaces = 4;
    t.onWorkspaceRemoved(1);
    eq(t.mainRowSize, 3);
    eq(t.appendageCount, 1);
    globalThis.global.workspace_manager = null;
});

test('external workspace-removed of appendage drops it', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":2,"dir":"up"},{"col":3,"dir":"down"}]',
        'main-row-size': 4,
    });
    const wm = new FakeWM(6);
    globalThis.global.workspace_manager = wm;
    const t = new Topology(s); t.load();
    wm.n_workspaces = 5;
    t.onWorkspaceRemoved(4); // удалили первый отросток снаружи
    eq(t.appendageCount, 1);
    eq(t.snapshot().appendages, [{col:3,dir:'down'}]);
    globalThis.global.workspace_manager = null;
});

print('\nTopology.columnHasAppendages / removeMainColumn');
test('columnHasAppendages reports presence', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":1,"dir":"up"},{"col":3,"dir":"down"}]',
        'main-row-size': 4,
    });
    withWM(6, () => {
        const t = new Topology(s); t.load();
        eq(t.columnHasAppendages(0), false);
        eq(t.columnHasAppendages(1), true);
        eq(t.columnHasAppendages(2), false);
        eq(t.columnHasAppendages(3), true);
    });
});

test('removeMainColumn shrinks row and reindexes later columns', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":3,"dir":"up"},{"col":4,"dir":"down"},{"col":1,"dir":"up"}]',
        'main-row-size': 5,
    });
    withWM(8, () => {
        const t = new Topology(s); t.load();
        // Удаляем пустую колонку 2 — col=3 → 2, col=4 → 3, col=1 не двигается.
        eq(t.removeMainColumn(2), true);
        eq(t.mainRowSize, 4);
        eq(t.snapshot().appendages, [
            {col:2,dir:'up'}, {col:3,dir:'down'}, {col:1,dir:'up'},
        ]);
    });
});

test('removeMainColumn refuses when column has appendages', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":2,"dir":"up"}]',
        'main-row-size': 4,
    });
    withWM(5, () => {
        const t = new Topology(s); t.load();
        eq(t.removeMainColumn(2), false);
        eq(t.mainRowSize, 4);
        eq(t.appendageCount, 1);
    });
});

test('removeMainColumn rejects out-of-range', () => {
    const s = new FakeSettings({ 'main-row-size': 3 });
    withWM(3, () => {
        const t = new Topology(s); t.load();
        eq(t.removeMainColumn(-1), false);
        eq(t.removeMainColumn(3),  false);
        eq(t.mainRowSize, 3);
    });
});

print('\nTopology.computeRotation');
test('rotate down promotes layer +1 to main, demotes layers above', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":1,"dir":"up"},{"col":1,"dir":"down"}]',
        'main-row-size': 3,
    });
    withWM(5, () => {
        const t = new Topology(s); t.load();
        // Initially: 0=col0, 1=col1main, 2=col2main, 3=col1up=-1, 4=col1down=+1
        const r = t.computeRotation(1, 'down');
        // Expected new state: col1 layers shift -1.
        // col1 main (idx 1) was layer 0, becomes -1 (first up appendage)
        // col1 up (idx 3) was -1, becomes -2 (second up appendage)
        // col1 down (idx 4) was +1, becomes 0 (new main)
        eq(r.newAppendages, [{col:1,dir:'up'}, {col:1,dir:'up'}]);
        eq(r.newLinearOf, [0, 3, 2, 4, 1]);
    });
});

test('rotate up promotes layer -1 to main, demotes layers below', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":1,"dir":"up"},{"col":1,"dir":"down"}]',
        'main-row-size': 3,
    });
    withWM(5, () => {
        const t = new Topology(s); t.load();
        const r = t.computeRotation(1, 'up');
        // col1 layers shift +1: main → +1, up=-1 → 0 (new main), down=+1 → +2
        eq(r.newAppendages, [{col:1,dir:'down'}, {col:1,dir:'down'}]);
        eq(r.newLinearOf, [0, 3, 2, 1, 4]);
    });
});

test('rotate down rejects column with no down layer', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":1,"dir":"up"}]',
        'main-row-size': 3,
    });
    withWM(4, () => {
        const t = new Topology(s); t.load();
        isNull(t.computeRotation(1, 'down'));
        // up rotation works since there is a -1 layer.
        const r = t.computeRotation(1, 'up');
        if (!r) throw new Error('expected non-null for up rotation');
    });
});

test('rotation does not touch other columns', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":1,"dir":"up"},{"col":2,"dir":"down"},{"col":1,"dir":"down"}]',
        'main-row-size': 3,
    });
    withWM(6, () => {
        const t = new Topology(s); t.load();
        // Initial linear:
        //   0=col0 main, 1=col1 main, 2=col2 main,
        //   3={col:1,up}=col1 layer-1,
        //   4={col:2,down}=col2 layer+1,
        //   5={col:1,down}=col1 layer+1
        const r = t.computeRotation(1, 'down');
        // col1 shifts -1: main→-1, -1→-2, +1→main.
        // col2 unchanged: main idx 2, layer+1 still appendage.
        // newLinearOf:
        //   idx 0 (col0) → 0
        //   idx 1 (col1 main, now -1) → first col1-up appendage
        //   idx 2 (col2) → 2
        //   idx 3 (col1 -1, now -2) → second col1-up appendage
        //   idx 4 (col2 +1) → first col2-down appendage
        //   idx 5 (col1 +1, now main) → 1
        // newAppendages order (cols asc): col1 ups, col1 downs, col2 ups, col2 downs.
        //   col1: 2 ups (depth1, depth2), 0 downs.
        //   col2: 0 ups, 1 down.
        // = [{col:1,up}, {col:1,up}, {col:2,down}]
        // Linear positions for appendages:
        //   M=3, so idx 3=col1up depth1, 4=col1up depth2, 5=col2down depth1.
        eq(r.newAppendages, [{col:1,dir:'up'}, {col:1,dir:'up'}, {col:2,dir:'down'}]);
        eq(r.newLinearOf, [0, 3, 2, 4, 5, 1]);
    });
});

print('\nTopology — corrupt storage fallback');
test('invalid JSON falls back to all-main', () => {
    const s = new FakeSettings({
        'appendages': 'not json',
        'main-row-size': 4,
    });
    withWM(7, () => {
        const t = new Topology(s); t.load();
        // невалидный JSON → stored=[], попадаем в фолбэк (total=7, считаем всё main)
        eq(t.mainRowSize, 7);
        eq(t.appendageCount, 0);
    });
});

test('invalid entries are filtered out', () => {
    const s = new FakeSettings({
        'appendages': '[{"col":2,"dir":"up"},"junk",{"col":-1,"dir":"up"},{"col":3,"dir":"down"}]',
        'main-row-size': 4,
    });
    withWM(6, () => {
        const t = new Topology(s); t.load();
        eq(t.mainRowSize, 4);
        eq(t.appendageCount, 2);
    });
});

// --- summary ---
print(`\n${passed} passed, ${failed} failed`);
if (failed > 0) imports.system.exit(1);
