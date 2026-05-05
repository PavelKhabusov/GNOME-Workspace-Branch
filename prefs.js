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

export default class WorkspaceBranchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        page.add(this._buildKeybindings(settings));
        page.add(this._buildBehavior(settings));
        page.add(this._buildIndicator(settings));
        page.add(this._buildRulesGroup(window, settings));
        page.add(this._buildProfilesGroup(window, settings));

        window.add(page);
    }

    // ─── helpers ───────────────────────────────────────────────────────

    _readArr(settings, key) {
        try {
            const v = JSON.parse(settings.get_string(key));
            return Array.isArray(v) ? v : [];
        } catch { return []; }
    }

    _writeArr(settings, key, arr) {
        settings.set_string(key, JSON.stringify(arr));
    }

    _addButton(label, onClick) {
        const btn = new Gtk.Button({
            child: new Adw.ButtonContent({ icon_name: 'list-add-symbolic', label }),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        btn.connect('clicked', onClick);
        return btn;
    }

    _iconButton(iconName, css, onClick) {
        const btn = new Gtk.Button({
            icon_name: iconName,
            css_classes: ['flat', ...(css || [])],
            valign: Gtk.Align.CENTER,
        });
        btn.connect('clicked', onClick);
        return btn;
    }

    _emptyRow(title, subtitle) {
        const row = new Adw.ActionRow({ title, subtitle });
        row.add_css_class('dim-label');
        return row;
    }

    // ─── unchanged sections ────────────────────────────────────────────

    _buildKeybindings(settings) {
        const kb = new Adw.PreferencesGroup({
            title: 'Keybindings',
            description: 'Use the standard accelerator syntax, e.g. <Super>Up.',
        });
        for (const [key, label] of KEYBIND_ROWS)
            kb.add(this._buildKeyRow(settings, key, label));
        return kb;
    }

    _buildBehavior(settings) {
        const beh = new Adw.PreferencesGroup({ title: 'Behavior' });

        const forget = new Adw.SwitchRow({
            title: 'Forget empty appendages on disable',
            subtitle: 'When the extension is disabled, drop empty vertical workspaces instead of keeping them.',
        });
        settings.bind('forget-empty-on-disable', forget, 'active', Gio.SettingsBindFlags.DEFAULT);
        beh.add(forget);

        const drum = new Adw.SwitchRow({
            title: 'Drum mode (Super+Up/Down rotates the column)',
            subtitle: 'Active workspace stays on the main row. Vertical swipes rotate the active column so a different appendage becomes the new main; Mutter is physically reindexed.',
        });
        settings.bind('drum-rotation', drum, 'active', Gio.SettingsBindFlags.DEFAULT);
        beh.add(drum);

        return beh;
    }

    _buildIndicator(settings) {
        const ind = new Adw.PreferencesGroup({ title: 'Indicator' });

        const branched = new Adw.SwitchRow({
            title: 'Show branches in Activities preview',
            subtitle: 'Render appendages as vertical bars above/below the native workspace dots. Off — show a separate standalone panel indicator instead.',
        });
        settings.bind('branched-indicator', branched, 'active', Gio.SettingsBindFlags.DEFAULT);
        ind.add(branched);

        const showBranches = new Adw.SwitchRow({
            title: 'Show vertical branches',
            subtitle: 'Render the vertical bars for appendages. Off — only the main horizontal row is drawn.',
        });
        settings.bind('indicator-show-branches', showBranches, 'active', Gio.SettingsBindFlags.DEFAULT);
        ind.add(showBranches);

        return ind;
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

    // ─── window rules ──────────────────────────────────────────────────

    _ruleSummary(rule) {
        const m = rule?.match || {};
        const t = rule?.target || {};
        const parts = [];
        if (m.desktop_id) parts.push(`app: ${m.desktop_id.replace(/\.desktop$/, '')}`);
        if (m.wm_class)   parts.push(`class: ${m.wm_class}`);
        if (m.app_id)     parts.push(`id: ${m.app_id}`);
        if (m.title)      parts.push(`title~ ${m.title}`);
        if (m.pid_comm)   parts.push(`proc: ${m.pid_comm}`);
        const title = parts.length ? parts.join('  ·  ') : '(empty match)';

        const layer = typeof t.layer === 'number' ? t.layer : 0;
        let layerStr;
        if (layer < 0)      layerStr = `${-layer} up`;
        else if (layer > 0) layerStr = `${layer} down`;
        else                layerStr = 'main';
        const create = t.create_if_missing ? ', auto-create' : '';
        const subtitle = `→ col ${t.col ?? '?'} · ${layerStr}${create}`;
        return { title, subtitle };
    }

    _ruleRow(rule, onEdit, onDelete) {
        const s = this._ruleSummary(rule);
        const row = new Adw.ActionRow({ title: s.title, subtitle: s.subtitle });
        row.add_suffix(this._iconButton('document-edit-symbolic', null, onEdit));
        row.add_suffix(this._iconButton('user-trash-symbolic', ['destructive-action'], onDelete));
        row.activatable_widget = row.get_first_child(); // not strictly needed; prevents double-edit on row click
        return row;
    }

    _buildRulesGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Window rules',
            description: 'Auto-route windows to (col, layer) on creation. Used as a fallback when no profile is active. First match wins.',
        });
        const addBtn = this._addButton('Add rule', () => {
            this._editRule(window, null, (rule) => {
                if (!rule) return;
                const list = this._readArr(settings, 'window-rules');
                list.push(rule);
                this._writeArr(settings, 'window-rules', list);
            });
        });
        group.set_header_suffix(addBtn);

        let rows = [];
        const refresh = () => {
            for (const row of rows) group.remove(row);
            rows = [];
            const rules = this._readArr(settings, 'window-rules');
            if (rules.length === 0) {
                const empty = this._emptyRow('No rules yet', 'Click Add rule to create one.');
                rows.push(empty);
                group.add(empty);
                return;
            }
            rules.forEach((rule, i) => {
                const row = this._ruleRow(rule,
                    () => this._editRule(window, rule, (updated) => {
                        if (!updated) return;
                        const list = this._readArr(settings, 'window-rules');
                        list[i] = updated;
                        this._writeArr(settings, 'window-rules', list);
                    }),
                    () => {
                        const list = this._readArr(settings, 'window-rules');
                        list.splice(i, 1);
                        this._writeArr(settings, 'window-rules', list);
                    });
                rows.push(row);
                group.add(row);
            });
        };
        refresh();
        settings.connect('changed::window-rules', refresh);
        return group;
    }

    _editRule(parent, existing, onDone) {
        const dialog = new Adw.AlertDialog({
            heading: existing ? 'Edit rule' : 'Add rule',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('save', 'Save');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18,
            margin_top: 6,
        });

        const matchGroup = new Adw.PreferencesGroup({
            title: 'Match',
            description: 'All filled fields combined with AND. Leave a field empty to ignore it.',
        });

        // Application picker — fastest path: pick from installed .desktop files,
        // we save desktop_id and match via Shell.WindowTracker at runtime.
        let pickedDesktopId = existing?.match?.desktop_id ?? '';
        const appRow = new Adw.ActionRow({
            title: 'Application',
            subtitle: pickedDesktopId
                ? this._desktopRowSubtitle(pickedDesktopId)
                : 'Pick from installed apps (matches via Shell.WindowTracker).',
        });
        const pickBtn = new Gtk.Button({
            child: new Adw.ButtonContent({
                icon_name: 'system-search-symbolic',
                label: 'Choose…',
            }),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        pickBtn.connect('clicked', () => {
            this._pickApp(parent, pickedDesktopId, (chosen) => {
                if (chosen === null) return; // cancel
                if (chosen === '') {
                    pickedDesktopId = '';
                    appRow.subtitle = 'Pick from installed apps (matches via Shell.WindowTracker).';
                    return;
                }
                pickedDesktopId = chosen;
                appRow.subtitle = this._desktopRowSubtitle(chosen);
            });
        });
        appRow.add_suffix(pickBtn);
        matchGroup.add(appRow);

        const wmClass = new Adw.EntryRow({ title: 'WM class (exact)' });
        wmClass.text = existing?.match?.wm_class ?? '';
        matchGroup.add(wmClass);

        const appId = new Adw.EntryRow({ title: 'App ID (Wayland app_id / GTK app id)' });
        appId.text = existing?.match?.app_id ?? '';
        matchGroup.add(appId);

        const titleRe = new Adw.EntryRow({ title: 'Title (regex)' });
        titleRe.text = existing?.match?.title ?? '';
        matchGroup.add(titleRe);

        const procName = new Adw.EntryRow({ title: 'Process name (/proc/<pid>/comm)' });
        procName.text = existing?.match?.pid_comm ?? '';
        matchGroup.add(procName);

        content.append(matchGroup);

        const targetGroup = new Adw.PreferencesGroup({ title: 'Target' });

        const colRow = new Adw.SpinRow({
            title: 'Column',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 99, step_increment: 1, page_increment: 1,
                value: existing?.target?.col ?? 0,
            }),
        });
        targetGroup.add(colRow);

        const layerRow = new Adw.SpinRow({
            title: 'Layer',
            subtitle: '−N up · 0 main · +N down',
            adjustment: new Gtk.Adjustment({
                lower: -10, upper: 10, step_increment: 1, page_increment: 1,
                value: existing?.target?.layer ?? 0,
            }),
        });
        targetGroup.add(layerRow);

        const createRow = new Adw.SwitchRow({
            title: 'Create appendage if missing',
            subtitle: 'Only applies when layer ≠ 0',
            active: !!existing?.target?.create_if_missing,
        });
        targetGroup.add(createRow);

        content.append(targetGroup);

        dialog.set_extra_child(content);

        dialog.connect('response', (_d, response) => {
            if (response !== 'save') { onDone(null); return; }
            const match = {};
            if (pickedDesktopId)              match.desktop_id = pickedDesktopId;
            const wm = wmClass.text.trim();   if (wm) match.wm_class = wm;
            const ai = appId.text.trim();     if (ai) match.app_id = ai;
            const ti = titleRe.text.trim();   if (ti) match.title = ti;
            const pc = procName.text.trim();  if (pc) match.pid_comm = pc;

            onDone({
                match,
                target: {
                    col: colRow.value,
                    layer: layerRow.value,
                    create_if_missing: createRow.active,
                },
            });
        });

        dialog.present(parent);
    }

    _desktopRowSubtitle(desktopId) {
        const info = Gio.DesktopAppInfo.new(desktopId);
        if (!info) return desktopId;
        return `${info.get_display_name()}  ·  ${desktopId}`;
    }

    _allApps() {
        const apps = Gio.AppInfo.get_all().filter(a => {
            try { return a.should_show && a.should_show(); } catch { return false; }
        });
        apps.sort((a, b) => {
            const an = (a.get_display_name() || '').toLowerCase();
            const bn = (b.get_display_name() || '').toLowerCase();
            return an < bn ? -1 : an > bn ? 1 : 0;
        });
        return apps;
    }

    _pickApp(parent, currentDesktopId, onChosen) {
        // Кастомный диалог: search-entry + scrolled ListBox с иконкой и именем.
        // Возвращает desktop_id (строка) при выборе, '' при Clear, null при Cancel.

        const dialog = new Adw.AlertDialog({
            heading: 'Pick application',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', 'Cancel');
        if (currentDesktopId) dialog.add_response('clear', 'Clear');
        dialog.set_response_appearance('cancel', Adw.ResponseAppearance.DEFAULT);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
        });
        const search = new Gtk.SearchEntry({
            placeholder_text: 'Filter by name or id…',
        });
        content.append(search);

        const listBox = new Gtk.ListBox({
            css_classes: ['boxed-list'],
            selection_mode: Gtk.SelectionMode.SINGLE,
        });
        const scrolled = new Gtk.ScrolledWindow({
            child: listBox,
            height_request: 380,
            min_content_width: 480,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        content.append(scrolled);

        const apps = this._allApps();
        let chosenId = null;

        const finish = (id) => {
            chosenId = id;
            // Fire response 'save' on row activation.
            dialog.response('save');
        };

        for (const app of apps) {
            const id = app.get_id();
            if (!id) continue;
            const name = app.get_display_name() || id;

            const row = new Gtk.ListBoxRow();
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 12,
                margin_top: 6, margin_bottom: 6,
                margin_start: 8, margin_end: 8,
            });

            const icon = app.get_icon();
            const img = new Gtk.Image({
                pixel_size: 28,
                gicon: icon,
            });
            box.append(img);

            const text = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                hexpand: true,
            });
            const nameLabel = new Gtk.Label({
                label: name, xalign: 0,
                ellipsize: 3, // PANGO_ELLIPSIZE_END
            });
            const idLabel = new Gtk.Label({
                label: id, xalign: 0,
                css_classes: ['caption', 'dim-label'],
                ellipsize: 3,
            });
            text.append(nameLabel);
            text.append(idLabel);
            box.append(text);

            row.set_child(box);
            row._desktopId = id;
            row._needle = `${name.toLowerCase()} ${id.toLowerCase()}`;
            listBox.append(row);

            if (id === currentDesktopId) {
                listBox.select_row(row);
            }
        }

        // Filtering.
        listBox.set_filter_func(row => {
            const q = (search.text || '').trim().toLowerCase();
            if (!q) return true;
            return row._needle && row._needle.includes(q);
        });
        search.connect('search-changed', () => listBox.invalidate_filter());

        listBox.connect('row-activated', (_lb, row) => {
            if (row && row._desktopId) finish(row._desktopId);
        });

        dialog.add_response('save', 'Select');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('save');

        dialog.set_extra_child(content);

        dialog.connect('response', (_d, response) => {
            if (response === 'cancel') { onChosen(null); return; }
            if (response === 'clear')  { onChosen(''); return; }
            if (response === 'save') {
                if (chosenId) { onChosen(chosenId); return; }
                const sel = listBox.get_selected_row();
                if (sel && sel._desktopId) onChosen(sel._desktopId);
                else onChosen(null);
                return;
            }
        });

        dialog.present(parent);
    }

    // ─── profiles ──────────────────────────────────────────────────────

    _profileRow(profile, onEdit, onDelete) {
        const name = profile?.name || '(unnamed)';
        const rules = Array.isArray(profile?.rules) ? profile.rules.length : 0;
        const autostart = Array.isArray(profile?.autostart) ? profile.autostart.length : 0;
        const subtitle = `${rules} rule(s) · ${autostart} autostart`;
        const row = new Adw.ActionRow({ title: name, subtitle });
        row.add_suffix(this._iconButton('document-edit-symbolic', null, onEdit));
        row.add_suffix(this._iconButton('user-trash-symbolic', ['destructive-action'], onDelete));
        return row;
    }

    _activeProfileRow(settings) {
        const model = new Gtk.StringList({ strings: ['(none)'] });
        const combo = new Adw.ComboRow({
            title: 'Active profile',
            subtitle: 'Profile to apply (none — use the standalone Window rules above).',
            model,
        });

        let suppress = false;
        const sync = () => {
            let profiles = [];
            try { profiles = JSON.parse(settings.get_string('profiles')); } catch {}
            if (!Array.isArray(profiles)) profiles = [];
            const names = ['(none)', ...profiles.map(p => (p && p.name) || '?')];
            suppress = true;
            model.splice(0, model.get_n_items(), names);
            const active = settings.get_string('active-profile');
            const idx = active ? profiles.findIndex(p => p && p.name === active) + 1 : 0;
            combo.selected = Math.max(0, idx);
            suppress = false;
        };
        sync();

        combo.connect('notify::selected', () => {
            if (suppress) return;
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

        settings.connect('changed::profiles', sync);
        settings.connect('changed::active-profile', sync);
        return combo;
    }

    _buildProfilesGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Profiles',
            description: 'Bundle rules + autostart commands into a named profile. The active profile overrides the standalone Window rules above.',
        });
        const addBtn = this._addButton('Add profile', () => {
            this._editProfile(window, null, (profile) => {
                if (!profile) return;
                const list = this._readArr(settings, 'profiles');
                list.push(profile);
                this._writeArr(settings, 'profiles', list);
            });
        });
        group.set_header_suffix(addBtn);

        group.add(this._activeProfileRow(settings));

        let rows = [];
        const refresh = () => {
            for (const row of rows) group.remove(row);
            rows = [];
            const profiles = this._readArr(settings, 'profiles');
            if (profiles.length === 0) {
                const empty = this._emptyRow('No profiles yet', 'Add one to bundle rules + autostart.');
                rows.push(empty);
                group.add(empty);
                return;
            }
            profiles.forEach((profile, i) => {
                const row = this._profileRow(profile,
                    () => this._editProfile(window, profile, (updated) => {
                        if (!updated) return;
                        const list = this._readArr(settings, 'profiles');
                        list[i] = updated;
                        this._writeArr(settings, 'profiles', list);
                    }),
                    () => {
                        const list = this._readArr(settings, 'profiles');
                        list.splice(i, 1);
                        this._writeArr(settings, 'profiles', list);
                        if (settings.get_string('active-profile') === (profile?.name ?? ''))
                            settings.set_string('active-profile', '');
                    });
                rows.push(row);
                group.add(row);
            });
        };
        refresh();
        settings.connect('changed::profiles', refresh);
        return group;
    }

    _editProfile(parent, existing, onDone) {
        const working = existing
            ? JSON.parse(JSON.stringify(existing))
            : { name: '', rules: [], autostart: [] };
        if (!Array.isArray(working.rules)) working.rules = [];
        if (!Array.isArray(working.autostart)) working.autostart = [];

        const dialog = new Adw.AlertDialog({
            heading: existing ? 'Edit profile' : 'Add profile',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('save', 'Save');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18,
            margin_top: 6,
        });

        const nameGroup = new Adw.PreferencesGroup();
        const nameRow = new Adw.EntryRow({ title: 'Profile name' });
        nameRow.text = working.name || '';
        nameGroup.add(nameRow);
        content.append(nameGroup);

        // Rules
        const rulesGroup = new Adw.PreferencesGroup({
            title: 'Rules',
            description: 'Routing rules for this profile.',
        });
        let ruleRows = [];
        const refreshRules = () => {
            for (const r of ruleRows) rulesGroup.remove(r);
            ruleRows = [];
            if (working.rules.length === 0) {
                const empty = this._emptyRow('No rules', 'Use Add to create one.');
                ruleRows.push(empty);
                rulesGroup.add(empty);
                return;
            }
            working.rules.forEach((rule, i) => {
                const r = this._ruleRow(rule,
                    () => this._editRule(parent, rule, (updated) => {
                        if (!updated) return;
                        working.rules[i] = updated;
                        refreshRules();
                    }),
                    () => {
                        working.rules.splice(i, 1);
                        refreshRules();
                    });
                ruleRows.push(r);
                rulesGroup.add(r);
            });
        };
        rulesGroup.set_header_suffix(this._addButton('Add', () => {
            this._editRule(parent, null, (rule) => {
                if (!rule) return;
                working.rules.push(rule);
                refreshRules();
            });
        }));
        refreshRules();
        content.append(rulesGroup);

        // Autostart
        const autoGroup = new Adw.PreferencesGroup({
            title: 'Autostart',
            description: 'Commands to run when this profile activates (once per session).',
        });
        let autoRows = [];
        const refreshAuto = () => {
            for (const r of autoRows) autoGroup.remove(r);
            autoRows = [];
            if (working.autostart.length === 0) {
                const empty = this._emptyRow('No autostart', 'Use Add to create one.');
                autoRows.push(empty);
                autoGroup.add(empty);
                return;
            }
            working.autostart.forEach((entry, i) => {
                const cmd = Array.isArray(entry?.cmd) ? entry.cmd.join(' ') : '(invalid)';
                const row = new Adw.ActionRow({ title: cmd, subtitle: 'Spawned via Gio.Subprocess (no shell).' });
                row.add_suffix(this._iconButton('document-edit-symbolic', null, () => {
                    this._editAutostart(parent, entry, (updated) => {
                        if (!updated) return;
                        working.autostart[i] = updated;
                        refreshAuto();
                    });
                }));
                row.add_suffix(this._iconButton('user-trash-symbolic', ['destructive-action'], () => {
                    working.autostart.splice(i, 1);
                    refreshAuto();
                }));
                autoRows.push(row);
                autoGroup.add(row);
            });
        };
        autoGroup.set_header_suffix(this._addButton('Add', () => {
            this._editAutostart(parent, null, (entry) => {
                if (!entry) return;
                working.autostart.push(entry);
                refreshAuto();
            });
        }));
        refreshAuto();
        content.append(autoGroup);

        dialog.set_extra_child(content);

        dialog.connect('response', (_d, response) => {
            if (response !== 'save') { onDone(null); return; }
            const name = nameRow.text.trim();
            if (!name) { onDone(null); return; }
            working.name = name;
            onDone(working);
        });

        dialog.present(parent);
    }

    _editAutostart(parent, existing, onDone) {
        const dialog = new Adw.AlertDialog({
            heading: existing ? 'Edit autostart command' : 'Add autostart command',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('save', 'Save');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 6,
        });

        const grp = new Adw.PreferencesGroup();
        const cmdRow = new Adw.EntryRow({ title: 'Command (shell-quoted args supported)' });
        cmdRow.text = Array.isArray(existing?.cmd) ? existing.cmd.join(' ') : '';
        grp.add(cmdRow);
        content.append(grp);

        const note = new Gtk.Label({
            label: 'Examples:  firefox  ·  code --new-window  ·  /usr/bin/foo "with space"',
            xalign: 0,
            wrap: true,
            css_classes: ['dim-label'],
        });
        content.append(note);

        dialog.set_extra_child(content);

        dialog.connect('response', (_d, response) => {
            if (response !== 'save') { onDone(null); return; }
            const text = cmdRow.text.trim();
            if (!text) { onDone(null); return; }
            try {
                const [ok, argv] = GLib.shell_parse_argv(text);
                if (!ok || !argv || argv.length === 0) { onDone(null); return; }
                onDone({ cmd: argv });
            } catch {
                onDone(null);
            }
        });

        dialog.present(parent);
    }
}
