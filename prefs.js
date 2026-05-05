import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
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
        page.add(this._buildLayoutPreview(settings));

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

    // AMW-стиль: иконка + имя + col/layer + edit + delete.
    // edit открывает «продвинутый» диалог с regexp/wm_class/etc.
    // `persist()` вызывается после inline-правки col/layer — пишет текущее
    // in-memory состояние массива в storage. Никакого refresh — UI остаётся
    // на месте, скролл и фокус сохраняются.
    _ruleRow(rule, persist, onEdit, onDelete) {
        const m = rule?.match || {};
        const t = rule?.target || {};

        const row = new Adw.ActionRow({ activatable: false });
        let icon = null;
        if (m.desktop_id) {
            const info = Gio.DesktopAppInfo.new(m.desktop_id);
            if (info) {
                icon = info.get_icon();
                row.title = info.get_display_name();
            } else {
                row.title = `(missing: ${m.desktop_id})`;
            }
        }
        if (!row.title) row.title = this._ruleSummary(rule).title;

        // Подзаголовок: тонкие совпадения сверх app, либо «direct match».
        const advParts = [];
        if (m.wm_class) advParts.push(`class: ${m.wm_class}`);
        if (m.app_id)   advParts.push(`id: ${m.app_id}`);
        if (m.title)    advParts.push(`title~ ${m.title}`);
        if (m.pid_comm) advParts.push(`proc: ${m.pid_comm}`);
        if (advParts.length) row.subtitle = advParts.join('  ·  ');

        const img = new Gtk.Image({
            css_classes: ['icon-dropshadow'],
            gicon: icon ?? Gio.ThemedIcon.new('application-x-executable'),
            pixel_size: 32,
        });
        row.add_prefix(img);

        // col / layer spinners.
        const wrap = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        const labelCol = new Gtk.Label({
            label: 'col',
            css_classes: ['caption', 'dim-label'],
        });
        wrap.append(labelCol);
        const colSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 99, step_increment: 1, value: t.col ?? 0,
            }),
            valign: Gtk.Align.CENTER,
            width_chars: 3,
        });
        wrap.append(colSpin);

        const labelLayer = new Gtk.Label({
            label: 'layer',
            css_classes: ['caption', 'dim-label'],
            margin_start: 6,
        });
        wrap.append(labelLayer);
        const layerSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: -10, upper: 10, step_increment: 1, value: t.layer ?? 0,
            }),
            valign: Gtk.Align.CENTER,
            width_chars: 3,
        });
        wrap.append(layerSpin);
        row.add_suffix(wrap);

        // Изменения col/layer мутируют `rule` напрямую — он же объект из
        // массива, который сохраняется через persist().
        const writeTarget = () => {
            rule.target ??= {};
            rule.target.col = colSpin.value;
            rule.target.layer = layerSpin.value;
            persist();
        };
        colSpin.connect('value-changed', writeTarget);
        layerSpin.connect('value-changed', writeTarget);

        // Autostart toggle: запускает .desktop через Gio.DesktopAppInfo.launch
        // один раз за сессию (см. lib/autostart.js).
        const autostartBtn = new Gtk.ToggleButton({
            icon_name: 'media-playback-start-symbolic',
            active: !!rule.autostart,
            tooltip_text: 'Autostart this app on session start',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        autostartBtn.connect('toggled', () => {
            if (rule.autostart === autostartBtn.active) return;
            rule.autostart = autostartBtn.active;
            persist();
        });
        row.add_suffix(autostartBtn);

        row.add_suffix(this._iconButton('document-edit-symbolic', null, onEdit));
        row.add_suffix(this._iconButton('user-trash-symbolic', ['destructive-action'], onDelete));
        return row;
    }

    _buildRulesListBox(window, opts) {
        // opts.getter: () => array (читает текущее состояние из storage)
        // opts.setter: (array) => void (пишет состояние в storage)
        // Возвращает { list, refresh }.
        //
        // Внутри держим cachedArr — живой массив, по которому строится UI.
        // Add/edit/delete мутируют cachedArr и хирургически правят ListBox
        // (insert/remove одной строки), без пересборки всего списка —
        // скролл и фокус сохраняются. Spinner-правки тоже мутируют cachedArr
        // через rule-ссылку и persist'ят, без перерендера.
        // refresh() — только для внешних импортов / ручных правок storage.
        let cachedArr = opts.getter();

        const list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });

        const persist = () => opts.setter(cachedArr);

        let addRow = null;

        const buildRow = (rule) => {
            let row;
            const onEdit = () => {
                this._editRule(window, rule, (updated) => {
                    if (!updated) return;
                    const idx = cachedArr.indexOf(rule);
                    if (idx < 0) return;
                    cachedArr[idx] = updated;
                    persist();
                    const newRow = buildRow(updated);
                    list.insert(newRow, idx);
                    list.remove(row);
                });
            };
            const onDelete = () => {
                const idx = cachedArr.indexOf(rule);
                if (idx < 0) return;
                cachedArr.splice(idx, 1);
                persist();
                list.remove(row);
            };
            row = this._ruleRow(rule, persist, onEdit, onDelete);
            return row;
        };

        const buildAddRow = () => this._buildAddRow(window, () => {
            const blocked = new Set(
                cachedArr.map(r => r?.match?.desktop_id).filter(Boolean));
            this._pickAppNative(window, blocked, (id) => {
                if (!id) return;
                if (cachedArr.some(r => r?.match?.desktop_id === id)) return;
                const rule = {
                    match: { desktop_id: id },
                    target: { col: 0, layer: 0, create_if_missing: true },
                };
                cachedArr.push(rule);
                persist();
                // Surgical insert: новая строка идёт перед addRow, остальные
                // строки и addRow остаются на своих местах — никакого скачка.
                list.insert(buildRow(rule), cachedArr.length - 1);
            });
        });

        const initial = () => {
            cachedArr.forEach(rule => list.append(buildRow(rule)));
            addRow = buildAddRow();
            list.append(addRow);
        };
        initial();

        const refresh = () => {
            cachedArr = opts.getter();
            while (list.get_first_child()) list.remove(list.get_first_child());
            initial();
        };

        return { list, refresh };
    }

    _buildRulesGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Window rules',
            description: 'Auto-route windows by application. First match wins. Used as a fallback when no profile is active.',
        });

        // Listbox держит cachedArr внутри. Чтобы внешние изменения (например,
        // DnD из «Layout preview») долетели сюда, ловим changed::window-rules
        // с self-write детектором: если значение совпадает с последним нашим —
        // никаких действий, иначе full refresh listbox'а.
        let lastWritten = settings.get_string('window-rules');
        const { list, refresh } = this._buildRulesListBox(window, {
            getter: () => this._readArr(settings, 'window-rules'),
            setter: (arr) => {
                const json = JSON.stringify(arr);
                lastWritten = json;
                settings.set_string('window-rules', json);
            },
        });
        settings.connect('changed::window-rules', () => {
            const cur = settings.get_string('window-rules');
            if (cur === lastWritten) return;
            lastWritten = cur;
            refresh();
        });
        group.add(list);
        return group;
    }

    _buildAddRow(window, onActivate) {
        const row = new Gtk.ListBoxRow({
            child: new Gtk.Image({
                icon_name: 'list-add-symbolic',
                pixel_size: 16,
                margin_top: 12, margin_bottom: 12,
                margin_start: 12, margin_end: 12,
            }),
        });
        // Click activation на ListBoxRow через клик-жест.
        const click = new Gtk.GestureClick();
        click.connect('released', () => onActivate());
        row.add_controller(click);
        return row;
    }

    _pickAppNative(parent, blockedIds, onChosen) {
        const root = parent.get_root ? parent.get_root() : parent;
        const dialog = new Gtk.AppChooserDialog({
            transient_for: root,
            modal: true,
        });
        const widget = dialog.get_widget();
        widget.set({ show_all: true, show_other: true });

        const blocked = blockedIds instanceof Set
            ? blockedIds
            : new Set(blockedIds || []);

        const updateSensitivity = () => {
            const info = widget.get_app_info();
            const id = info ? info.get_id() : null;
            dialog.set_response_sensitive(Gtk.ResponseType.OK,
                !!(id && !blocked.has(id)));
        };
        widget.connect('application-selected', updateSensitivity);
        widget.connect('application-activated', () => {
            const info = widget.get_app_info();
            const id = info ? info.get_id() : null;
            if (id && !blocked.has(id)) dialog.response(Gtk.ResponseType.OK);
        });
        updateSensitivity();

        dialog.connect('response', (_d, response) => {
            const info = widget.get_app_info();
            dialog.destroy();
            if (response === Gtk.ResponseType.OK && info) {
                onChosen(info.get_id());
            } else {
                onChosen(null);
            }
        });
        dialog.show();
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

        const procName = new Adw.EntryRow({ title: 'Process name' });
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

    // ─── layout preview (2D grid + DnD) ────────────────────────────────

    _buildLayoutPreview(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Layout preview',
            description: 'Where each rule places its windows. Drag an icon to retarget the rule to a different (col, layer).',
        });

        const wrap = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 4, margin_bottom: 4,
        });

        let lastWritten = settings.get_string('window-rules');
        let rebuild;
        rebuild = () => {
            // Clear children.
            let child = wrap.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                wrap.remove(child);
                child = next;
            }

            const mainRowSize = Math.max(1, settings.get_int('main-row-size') || 1);
            let appendages = [];
            try { appendages = JSON.parse(settings.get_string('appendages')) || []; } catch {}
            if (!Array.isArray(appendages)) appendages = [];
            const rules = this._readArr(settings, 'window-rules');

            // Диапазон слоёв = max глубина из appendages + max от target'ов.
            let minLayer = 0, maxLayer = 0;
            for (const a of appendages) {
                if (a?.dir === 'up')   minLayer = Math.min(minLayer, -1);
                if (a?.dir === 'down') maxLayer = Math.max(maxLayer, 1);
            }
            for (const r of rules) {
                const l = r?.target?.layer ?? 0;
                if (l < minLayer) minLayer = Math.max(l, -3); // clamp
                if (l > maxLayer) maxLayer = Math.min(l, 3);
            }
            // Гарантируем хоть одну строку (main).
            if (minLayer === 0 && maxLayer === 0) {
                // OK, just main row.
            }

            const grid = new Gtk.Grid({
                column_spacing: 6,
                row_spacing: 6,
                margin_top: 4, margin_bottom: 4,
            });

            // Header: col labels.
            for (let c = 0; c < mainRowSize; c++) {
                const l = new Gtk.Label({
                    label: `col ${c}`,
                    css_classes: ['caption', 'dim-label'],
                    xalign: 0.5,
                });
                grid.attach(l, c + 1, 0, 1, 1);
            }

            let rowIdx = 1;
            for (let layer = minLayer; layer <= maxLayer; layer++) {
                const layerLbl = new Gtk.Label({
                    label: layer === 0 ? 'main'
                          : layer < 0 ? `↑${-layer}`
                          :              `↓${layer}`,
                    css_classes: ['caption', 'dim-label'],
                    xalign: 1,
                    margin_end: 4,
                });
                grid.attach(layerLbl, 0, rowIdx, 1, 1);

                for (let c = 0; c < mainRowSize; c++) {
                    grid.attach(this._previewCell(settings, c, layer, rules), c + 1, rowIdx, 1, 1);
                }
                rowIdx++;
            }

            const scrolled = new Gtk.ScrolledWindow({
                hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
                vscrollbar_policy: Gtk.PolicyType.NEVER,
                propagate_natural_width: true,
                propagate_natural_height: true,
                hexpand: true,
                child: grid,
            });
            wrap.append(scrolled);
        };

        rebuild();

        // Перерендер на любые изменения, но только когда это НЕ наша же
        // self-запись — иначе DnD-drop вызвал бы rebuild прямо в обработчике.
        const onChanged = () => {
            const cur = settings.get_string('window-rules');
            if (cur === lastWritten) return;
            lastWritten = cur;
            rebuild();
        };
        settings.connect('changed::window-rules', onChanged);
        settings.connect('changed::main-row-size', () => { lastWritten = ''; rebuild(); });
        settings.connect('changed::appendages',    () => { lastWritten = ''; rebuild(); });

        // Экспортируем self-write маркер для drop-handler'а.
        wrap._markWritten = () => {
            lastWritten = settings.get_string('window-rules');
            rebuild();
        };

        group.add(wrap);
        return group;
    }

    _previewCell(settings, col, layer, rules) {
        const matching = rules.filter(r =>
            (r?.target?.col ?? 0) === col && (r?.target?.layer ?? 0) === layer
        );

        const frame = new Gtk.Frame({
            css_classes: ['card'],
            width_request: 96,
            height_request: 56,
        });

        const flow = new Gtk.FlowBox({
            margin_top: 4, margin_bottom: 4,
            margin_start: 4, margin_end: 4,
            min_children_per_line: 1,
            max_children_per_line: 4,
            row_spacing: 2, column_spacing: 2,
            selection_mode: Gtk.SelectionMode.NONE,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            homogeneous: false,
        });

        for (const rule of matching) {
            const did = rule?.match?.desktop_id;
            if (!did) continue;
            const info = Gio.DesktopAppInfo.new(did);
            const icon = info ? info.get_icon() : Gio.ThemedIcon.new('application-x-executable');
            const name = info ? info.get_display_name() : did;

            const img = new Gtk.Image({
                css_classes: ['icon-dropshadow'],
                gicon: icon,
                pixel_size: 28,
                tooltip_text: name,
            });
            // Drag source.
            const drag = new Gtk.DragSource();
            drag.set_actions(Gdk.DragAction.MOVE);
            drag.connect('prepare', () => {
                const value = new GObject.Value();
                value.init(GObject.TYPE_STRING);
                value.set_string(did);
                return Gdk.ContentProvider.new_for_value(value);
            });
            // Полупрозрачный во время перетаскивания — feedback.
            drag.connect('drag-begin', () => img.opacity = 0.4);
            drag.connect('drag-end', () => img.opacity = 1.0);
            img.add_controller(drag);
            flow.append(img);
        }

        frame.set_child(flow);

        // Drop target.
        const drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        drop.connect('drop', (_t, value /* string */) => {
            const did = value;
            if (!did) return false;
            const arr = this._readArr(settings, 'window-rules');
            const rule = arr.find(r => r?.match?.desktop_id === did);
            if (!rule) return false;
            rule.target ??= {};
            if (rule.target.col === col && rule.target.layer === layer) return false;
            rule.target.col = col;
            rule.target.layer = layer;
            this._writeArr(settings, 'window-rules', arr);
            // Перерендер. Делаем после microtask, чтобы дождаться завершения drop.
            const wrap = frame.get_parent()?.get_parent()?.get_parent();
            const mark = wrap && wrap._markWritten;
            if (mark) GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { mark(); return GLib.SOURCE_REMOVE; });
            return true;
        });
        // Подсветка над целью.
        drop.connect('enter', () => { frame.add_css_class('accent'); return Gdk.DragAction.MOVE; });
        drop.connect('leave', () => frame.remove_css_class('accent'));
        frame.add_controller(drop);

        return frame;
    }

}
