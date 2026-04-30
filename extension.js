import Gio from 'gi://Gio';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Topology } from './lib/topology.js';
import { WorkspaceOps } from './lib/workspaces.js';
import { Navigator } from './lib/navigator.js';
import { Keybindings } from './lib/keybindings.js';
import { SystemKeys } from './lib/system-keys.js';
import { Indicator } from './lib/indicator.js';
import { BranchedIndicator } from './lib/branched-indicator.js';
import { Swipes } from './lib/swipes.js';
import * as OverviewPatch from './lib/overview-patch.js';
import * as AnimationPatch from './lib/animation-patch.js';
import * as VerticalSwipe from './lib/vertical-swipe.js';
import * as AutoCleanup from './lib/auto-cleanup.js';
import * as WorkspacesViewPatch from './lib/workspaces-view-patch.js';

const OUR_KEY_NAMES = [
    'switch-up', 'switch-down', 'switch-left', 'switch-right',
    'create-up', 'create-down', 'extend-row-right',
    'move-window-up', 'move-window-down', 'move-window-left', 'move-window-right',
    'remove-current',
];

const MUTTER_SCHEMA = 'org.gnome.mutter';
const DYNAMIC_KEY = 'dynamic-workspaces';

export default class WorkspaceBranchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._mutter = new Gio.Settings({ schema_id: MUTTER_SCHEMA });

        // Static workspaces — иначе Mutter сам добавляет/удаляет последний пустой
        // и наша топология рассинхронизируется.
        this._dynamicWasOn = this._mutter.get_boolean(DYNAMIC_KEY);
        if (this._dynamicWasOn)
            this._mutter.set_boolean(DYNAMIC_KEY, false);

        this._topology = new Topology(this._settings);
        this._topology.load();

        this._ops = new WorkspaceOps(this._topology);
        this._navigator = new Navigator(this._topology, this._ops);

        // Снимаем пересекающиеся системные accel-ы ДО регистрации наших,
        // иначе Mutter откажет в регистрации — Super+Down уйдёт в unmaximize.
        this._systemKeys = new SystemKeys(this._settings, OUR_KEY_NAMES);
        this._systemKeys.install();

        this._keybindings = new Keybindings(this._settings, this._navigator);
        this._keybindings.enable();

        const wm = global.workspace_manager;

        // Восстановление отростков после рестарта shell (Wayland теряет воркспейсы).
        // Сигналы подключаем ПОСЛЕ — чтобы append_new_workspace не путал handlerы.
        this._restoreAppendages();

        this._addedSignal = wm.connect('workspace-added',
            (_wm, idx) => this._topology.onWorkspaceAdded(idx));
        this._removedSignal = wm.connect('workspace-removed',
            (_wm, idx) => this._topology.onWorkspaceRemoved(idx));

        // Индикатор подписывается на те же сигналы — порядок connect гарантирует,
        // что topology обновится первой, а индикатор отрисует уже актуальное состояние.
        this._installIndicator();
        this._indicatorSettingId = this._settings.connect('changed::branched-indicator',
            () => this._reinstallIndicator());

        // Замена _thumbnailsBox в overview на наш GridThumbnailsBox для 2D-раскладки и DnD.
        OverviewPatch.install(this._topology, this._ops);

        // Patch animateSwitch — пропускаем горизонтальный slide для
        // вертикальных/диагональных переходов (main↔отросток в топологии).
        AnimationPatch.install(this._topology);

        // 4-пальцевый свайп → лестница overview / Super+scroll → switchUp/Down.
        this._swipes = new Swipes(this._navigator);
        this._swipes.enable();

        // Native-style 3-finger vertical swipe with progress.
        VerticalSwipe.install(this._topology);

        // Авто-удаление пустых отростков при switch / window close.
        AutoCleanup.install(this._topology, this._ops);

        // Замена WorkspacesView через subclass+swap для 2D layout.
        WorkspacesViewPatch.install(this._topology);
    }

    _installIndicator() {
        if (this._settings.get_boolean('branched-indicator')) {
            this._branched = new BranchedIndicator(this._topology, this._settings);
            if (this._branched.install()) return;
            // Не смогли подцепиться к ActivitiesButton — фолбэк на standalone.
            this._branched = null;
        }
        this._indicator = new Indicator(this._topology);
        Main.panel.addToStatusArea('workspace-branch', this._indicator);
    }

    _uninstallIndicator() {
        this._branched?.uninstall();
        this._branched = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    _reinstallIndicator() {
        this._uninstallIndicator();
        this._installIndicator();
    }

    _restoreAppendages() {
        const wm = global.workspace_manager;
        const have = wm.n_workspaces;
        const need = this._topology.mainRowSize + this._topology.appendageCount;
        for (let i = have; i < need; i++)
            wm.append_new_workspace(false, global.get_current_time());
    }

    // Удаляем отростки без окон. Идём с конца, чтобы Mutter сдвигал индексы
    // только тех, что мы уже не трогаем; topology splice'ает массив с того же конца.
    _dropEmptyAppendages() {
        const wm = global.workspace_manager;
        const t = this._topology;
        for (let idx = wm.n_workspaces - 1; idx >= t.mainRowSize; idx--) {
            const ws = wm.get_workspace_by_index(idx);
            if (!ws) continue;
            if (ws.list_windows().length === 0)
                this._ops.remove(idx);
        }
    }

    disable() {
        WorkspacesViewPatch.uninstall();
        AutoCleanup.uninstall();
        VerticalSwipe.uninstall();

        this._swipes?.disable();
        this._swipes = null;

        AnimationPatch.uninstall();
        OverviewPatch.uninstall();

        if (this._indicatorSettingId) {
            this._settings.disconnect(this._indicatorSettingId);
            this._indicatorSettingId = 0;
        }
        this._uninstallIndicator();

        const wm = global.workspace_manager;
        if (this._addedSignal) {
            wm.disconnect(this._addedSignal);
            this._addedSignal = null;
        }
        if (this._removedSignal) {
            wm.disconnect(this._removedSignal);
            this._removedSignal = null;
        }

        if (this._settings?.get_boolean('forget-empty-on-disable'))
            this._dropEmptyAppendages();

        this._keybindings?.disable();
        this._keybindings = null;
        this._systemKeys?.restore();
        this._systemKeys = null;
        this._navigator = null;
        this._ops = null;
        this._topology = null;

        if (this._dynamicWasOn && this._mutter)
            this._mutter.set_boolean(DYNAMIC_KEY, true);
        this._mutter = null;
        this._settings = null;
    }
}
