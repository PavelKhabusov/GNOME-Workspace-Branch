import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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

        page.add(this._buildRulesGroup(settings));
        page.add(this._buildProfilesGroup(settings));

        window.add(page);
    }

    _buildProfilesGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Profiles',
            description:
                'Bundle a set of rules + autostart commands into a named profile. ' +
                'The active profile overrides the standalone "Window rules" above. ' +
                'Format: [{"name": "Work", "rules": [...], "autostart": [{"cmd": ["firefox"]}, ...]}]. ' +
                'Autostart spawns once per session per profile (cached in $XDG_RUNTIME_DIR).',
        });

        const model = new Gtk.StringList({ strings: ['(none)'] });
        const combo = new Adw.ComboRow({
            title: 'Active profile',
            subtitle: 'Profile to activate (none = use standalone rules).',
            model,
        });

        const refreshList = () => {
            let profiles = [];
            try { profiles = JSON.parse(settings.get_string('profiles')); } catch {}
            if (!Array.isArray(profiles)) profiles = [];
            const names = ['(none)', ...profiles.map(p => (p && p.name) || '?')];
            // splice(pos, n_remove, additions)
            model.splice(0, model.get_n_items(), names);
            const active = settings.get_string('active-profile');
            const idx = active ? profiles.findIndex(p => p && p.name === active) + 1 : 0;
            combo.selected = Math.max(0, idx);
        };
        refreshList();

        combo.connect('notify::selected', () => {
            const i = combo.selected;
            if (i === 0) {
                if (settings.get_string('active-profile') !== '')
                    settings.set_string('active-profile', '');
                return;
            }
            let profiles = [];
            try { profiles = JSON.parse(settings.get_string('profiles')); } catch {}
            if (!Array.isArray(profiles)) return;
            const target = profiles[i - 1];
            const name = target && target.name ? target.name : '';
            if (settings.get_string('active-profile') !== name)
                settings.set_string('active-profile', name);
        });

        settings.connect('changed::profiles', refreshList);
        settings.connect('changed::active-profile', refreshList);

        group.add(combo);

        const buf = new Gtk.TextBuffer({
            text: settings.get_string('profiles') || '[]',
        });
        const view = new Gtk.TextView({
            buffer: buf,
            monospace: true,
            top_margin: 6, bottom_margin: 6,
            left_margin: 8, right_margin: 8,
        });
        const scrolled = new Gtk.ScrolledWindow({
            height_request: 240,
            has_frame: true,
            child: view,
        });
        const status = new Gtk.Label({
            xalign: 0, margin_top: 4,
            css_classes: ['dim-label'], label: '',
        });

        let debounce = 0;
        const persist = () => {
            const raw = buf.text;
            try {
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) {
                    status.label = 'Top-level must be an array.';
                    return;
                }
                settings.set_string('profiles', raw);
                status.label = `Saved · ${parsed.length} profile(s).`;
            } catch (e) {
                status.label = `Invalid JSON: ${e.message}`;
            }
        };
        buf.connect('changed', () => {
            if (debounce) GLib.source_remove(debounce);
            debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                debounce = 0;
                persist();
                return GLib.SOURCE_REMOVE;
            });
        });
        settings.connect('changed::profiles', () => {
            const v = settings.get_string('profiles') || '[]';
            if (buf.text !== v) buf.text = v;
        });

        group.add(scrolled);
        group.add(status);
        return group;
    }

    _buildRulesGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Window rules',
            description:
                'Auto-route windows to (col, layer) on creation. JSON array; ' +
                'each entry: {"match": {"wm_class"|"app_id"|"title" (regex)|"pid_comm": "..."}, ' +
                '"target": {"col": N, "layer": N, "create_if_missing": false}}. ' +
                'First match wins. Tip: pid_comm distinguishes processes that share wm_class ' +
                '(e.g. Unity Hub vs Unity Editor — both "Unity").',
        });

        const buf = new Gtk.TextBuffer({
            text: settings.get_string('window-rules') || '[]',
        });
        const view = new Gtk.TextView({
            buffer: buf,
            monospace: true,
            top_margin: 6, bottom_margin: 6,
            left_margin: 8, right_margin: 8,
        });
        const scrolled = new Gtk.ScrolledWindow({
            height_request: 240,
            has_frame: true,
            child: view,
        });

        const status = new Gtk.Label({
            xalign: 0,
            margin_top: 4,
            css_classes: ['dim-label'],
            label: '',
        });

        let debounce = 0;
        const persist = () => {
            const raw = buf.text;
            try {
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) {
                    status.label = 'Top-level must be an array.';
                    return;
                }
                settings.set_string('window-rules', raw);
                status.label = `Saved · ${parsed.length} rule(s).`;
            } catch (e) {
                status.label = `Invalid JSON: ${e.message}`;
            }
        };
        buf.connect('changed', () => {
            if (debounce) GLib.source_remove(debounce);
            debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                debounce = 0;
                persist();
                return GLib.SOURCE_REMOVE;
            });
        });
        // Внешние изменения (gsettings/dconf) — синхронизируем буфер.
        settings.connect('changed::window-rules', () => {
            const v = settings.get_string('window-rules') || '[]';
            if (buf.text !== v) buf.text = v;
        });

        group.add(scrolled);
        group.add(status);
        return group;
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
