import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const KEYBIND_ROWS = [
    ['switch-up',         'Switch up'],
    ['switch-down',       'Switch down'],
    ['switch-left',       'Switch left'],
    ['switch-right',      'Switch right'],
    ['create-up',         'Create above'],
    ['create-down',       'Create below'],
    ['extend-row-right',  'Extend main row (new column on the right)'],
    ['move-window-up',    'Move window up'],
    ['move-window-down',  'Move window down'],
    ['move-window-left',  'Move window left'],
    ['move-window-right', 'Move window right'],
    ['remove-current',    'Remove current appendage'],
];

export default class WorkspaceGridPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();

        const kb = new Adw.PreferencesGroup({
            title: 'Keybindings',
            description: 'Use the standard accelerator syntax, e.g. <Super>Up.',
        });
        for (const [key, label] of KEYBIND_ROWS)
            kb.add(this._buildKeyRow(settings, key, label));
        page.add(kb);

        const beh = new Adw.PreferencesGroup({ title: 'Behavior' });
        const forget = new Adw.SwitchRow({
            title: 'Forget empty appendages on disable',
            subtitle: 'When the extension is disabled, drop empty vertical workspaces instead of keeping them.',
        });
        settings.bind('forget-empty-on-disable', forget, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        beh.add(forget);

        const drum = new Adw.SwitchRow({
            title: 'Drum mode (Super+Up/Down rotates the column)',
            subtitle: 'Active workspace stays on the main row. Vertical swipes rotate the active column so a different appendage becomes the new main; Mutter is physically reindexed.',
        });
        settings.bind('drum-rotation', drum, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        beh.add(drum);
        page.add(beh);

        const ind = new Adw.PreferencesGroup({ title: 'Indicator' });
        const branched = new Adw.SwitchRow({
            title: 'Show branches in Activities preview',
            subtitle: 'Render appendages as vertical bars above/below the native workspace dots. Off — show a separate standalone panel indicator instead.',
        });
        settings.bind('branched-indicator', branched, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        ind.add(branched);

        const showBranches = new Adw.SwitchRow({
            title: 'Show vertical branches',
            subtitle: 'Render the vertical bars for appendages. Off — only the main horizontal row is drawn (clean native look while still using the extension).',
        });
        settings.bind('indicator-show-branches', showBranches, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        ind.add(showBranches);
        page.add(ind);

        window.add(page);
    }

    _buildKeyRow(settings, key, label) {
        const row = new Adw.ActionRow({ title: label });
        const entry = new Gtk.Entry({
            text: settings.get_strv(key)[0] ?? '',
            valign: Gtk.Align.CENTER,
            width_chars: 24,
        });
        entry.connect('changed', () => {
            const v = entry.get_text().trim();
            settings.set_strv(key, v ? [v] : []);
        });
        row.add_suffix(entry);
        row.activatable_widget = entry;
        return row;
    }
}
