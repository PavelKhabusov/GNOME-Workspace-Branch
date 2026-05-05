// Панельная кнопка для быстрой смены активного профиля.
// Показывает имя текущего профиля и при клике даёт меню с (none) + всеми
// профилями из настройки. Если профилей нет — кнопка скрыта.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export const ProfileSwitcher = GObject.registerClass(
class ProfileSwitcher extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'GNOME Workspace Branch — profile', false);
        this._settings = settings;

        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 0 6px;',
        });
        this.add_child(this._label);

        this._activeId = this._settings.connect('changed::active-profile',
            () => this._refresh());
        this._profilesId = this._settings.connect('changed::profiles',
            () => this._refresh());

        this._refresh();
    }

    _profilesArr() {
        try {
            const arr = JSON.parse(this._settings.get_string('profiles'));
            return Array.isArray(arr) ? arr.filter(p => p && p.name) : [];
        } catch {
            return [];
        }
    }

    _activeName() {
        return this._settings.get_string('active-profile') || '';
    }

    _refresh() {
        const profiles = this._profilesArr();
        if (profiles.length === 0) {
            this.hide();
            return;
        }
        this.show();

        const active = this._activeName();
        const found = active ? profiles.find(p => p.name === active) : null;
        this._label.text = `▾ ${found ? found.name : '(none)'}`;

        this.menu.removeAll();

        const noneItem = new PopupMenu.PopupMenuItem('(none)');
        if (!active) noneItem.setOrnament(PopupMenu.Ornament.DOT);
        noneItem.connect('activate', () => {
            if (this._settings.get_string('active-profile') !== '')
                this._settings.set_string('active-profile', '');
        });
        this.menu.addMenuItem(noneItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        for (const p of profiles) {
            const item = new PopupMenu.PopupMenuItem(p.name);
            if (p.name === active) item.setOrnament(PopupMenu.Ornament.DOT);
            item.connect('activate', () => {
                if (this._settings.get_string('active-profile') !== p.name)
                    this._settings.set_string('active-profile', p.name);
            });
            this.menu.addMenuItem(item);
        }
    }

    destroy() {
        if (this._activeId)   { this._settings.disconnect(this._activeId);   this._activeId = 0; }
        if (this._profilesId) { this._settings.disconnect(this._profilesId); this._profilesId = 0; }
        super.destroy();
    }
});
