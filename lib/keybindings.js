import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ACTIONS = [
    ['switch-up',         'switchUp'],
    ['switch-down',       'switchDown'],
    ['switch-left',       'switchLeft'],
    ['switch-right',      'switchRight'],
    ['create-up',         'createUp'],
    ['create-down',       'createDown'],
    ['extend-row-right',  'extendRowRight'],
    ['extend-row-left',   'extendRowLeft'],
    ['move-window-up',    'moveWindowUp'],
    ['move-window-down',  'moveWindowDown'],
    ['move-window-left',  'moveWindowLeft'],
    ['move-window-right', 'moveWindowRight'],
    ['remove-current',    'removeCurrent'],
];

export class Keybindings {
    constructor(settings, navigator) {
        this._settings = settings;
        this._navigator = navigator;
        this._added = [];
    }

    enable() {
        const mode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        for (const [key, method] of ACTIONS) {
            const accel = this._settings.get_strv(key)[0] ?? '(unset)';
            const ok = Main.wm.addKeybinding(
                key,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                mode,
                () => this._navigator[method](),
            );
            if (ok) {
                this._added.push(key);
                console.log(`[workspace-branch] bound ${key} -> ${accel}`);
            } else {
                console.warn(`[workspace-branch] FAILED to bind ${key} (${accel}) — likely conflict`);
            }
        }
    }

    disable() {
        for (const key of this._added)
            Main.wm.removeKeybinding(key);
        this._added = [];
    }
}
