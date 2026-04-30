import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Заменяет содержимое родного ActivitiesButton: натив. WorkspaceDot
// для каждой main-колонки + «приклеенные» стрипы сверху/снизу для отростков.
//
// Натив. WorkspaceDot берём через .constructor живого экземпляра — родные
// style_class, scale, expansion-анимация работают как у GNOME.
//
// Layout-инвариант:
//  Стрипы НЕ участвуют в подсчёте preferred-size колонки. Кастомный
//  BranchColumn extends Clutter.Actor делегирует preferred_width/height
//  доту, а стрипы аллоцирует «снаружи» — за пределами своего allocation,
//  но в пределах высоты ActivitiesButton (он clip'ом не режет).
//  Итог: горизонтальный flow точек идентичен нативу, добавление/убирание
//  слоёв НЕ сдвигает соседей и не сдвигает сам dot.
//
// Анимации:
//  active-workspace-changed → ease_property('expansion', ...) на доте +
//  ease({opacity}) на стрипах. notify::expansion триггерит queue_relayout,
//  vfunc_allocate колонки пересчитывает позиции стрипов от текущего
//  scaleY/scaleX дота — стрипы остаются «приклеенными» к pill'у при росте.

const STRIPE_H       = 2;     // толщина стрипы (мини-pill за активным)
const STRIPE_GAP     = 0;     // зазор между соседними стрипами
const NECK_GAP       = 0;     // зазор стрипы и видимого края pill'а
const ACTIVE_ALPHA   = 1.0;
const NEAR_ALPHA     = 0.65;  // ближайший к pill'у слой
const FAR_ALPHA      = 0.30;  // дальний
const INACTIVE_COL_F = 0.55;  // умножитель для колонок без активного слоя
const MAX_LAYERS     = 2;
const ANIM_MS        = 180;
const EASE_MODE      = Clutter.AnimationMode.EASE_OUT_QUAD;
const SCALE_MIN      = 0.75;  // совпадает с native INACTIVE_WORKSPACE_DOT_SCALE

const BranchColumn = GObject.registerClass(
class BranchColumn extends Clutter.Actor {
    _init(dot, upStripes, downStripes) {
        super._init();
        this._dot = dot;
        this._upStripes = upStripes;
        this._downStripes = downStripes;

        this.add_child(dot);
        for (const s of upStripes) this.add_child(s);
        for (const s of downStripes) this.add_child(s);

        // На expansion дота стрипы должны переаллоцироваться, чтобы
        // приехать к новому видимому краю pill'а.
        dot.connect('notify::expansion', () => this.queue_relayout());
    }

    vfunc_get_preferred_width(forHeight) {
        return this._dot.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(forWidth) {
        return this._dot.get_preferred_height(forWidth);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const w = box.x2 - box.x1;
        const h = box.y2 - box.y1;

        const dotBox = new Clutter.ActorBox();
        dotBox.x1 = 0; dotBox.y1 = 0; dotBox.x2 = w; dotBox.y2 = h;
        this._dot.allocate(dotBox);

        // Видимый pill = allocation × scale (scale лерпит вместе с expansion).
        const scale = SCALE_MIN + (1 - SCALE_MIN) * this._dot.expansion;
        const visW = w * scale;
        const visH = h * scale;
        const pillTopY    = (h - visH) / 2;
        const pillBottomY = pillTopY + visH;
        const stripeX1    = (w - visW) / 2;
        const stripeX2    = stripeX1 + visW;

        // Up: индекс layer'а растёт от дальнего к ближнему. Ближайший к доту
        // — последний в массиве (соответствует l = -1). Аллоцируем СНИЗУ
        // вверх от пилла.
        let yCur = pillTopY - NECK_GAP;
        for (let i = this._upStripes.length - 1; i >= 0; i--) {
            yCur -= STRIPE_H;
            const sBox = new Clutter.ActorBox();
            sBox.x1 = stripeX1; sBox.x2 = stripeX2;
            sBox.y1 = yCur;     sBox.y2 = yCur + STRIPE_H;
            this._upStripes[i].allocate(sBox);
            yCur -= STRIPE_GAP;
        }

        // Down: ближайший — первый (l = +1). Аллоцируем СВЕРХУ вниз от пилла.
        let yCur2 = pillBottomY + NECK_GAP;
        for (const s of this._downStripes) {
            const sBox = new Clutter.ActorBox();
            sBox.x1 = stripeX1; sBox.x2 = stripeX2;
            sBox.y1 = yCur2;    sBox.y2 = yCur2 + STRIPE_H;
            s.allocate(sBox);
            yCur2 += STRIPE_H + STRIPE_GAP;
        }
    }
});

export class BranchedIndicator {
    constructor(topology, settings) {
        this._topology = topology;
        this._settings = settings;
        this._wm = global.workspace_manager;
        this._installed = false;

        this._activitiesBtn = null;
        this._origIndicator = null;
        this._DotClass = null;

        this._container = null;
        this._columns = [];

        this._activeId   = 0;
        this._addedId    = 0;
        this._removedId  = 0;
        this._settingsId = 0;
    }

    install() {
        const activities = Main.panel.statusArea.activities;
        if (!activities) return false;

        const orig = activities.get_first_child();
        if (!orig) return false;
        const sampleDot = orig.get_first_child();
        if (!sampleDot || !sampleDot.constructor) return false;

        this._activitiesBtn = activities;
        this._origIndicator = orig;
        this._DotClass = sampleDot.constructor;

        activities.remove_child(orig);

        this._container = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });
        activities.add_child(this._container);

        this._activeId  = this._wm.connect('active-workspace-changed', () => this._updateActive(false));
        this._addedId   = this._wm.connect('workspace-added',          () => this._rebuild());
        this._removedId = this._wm.connect('workspace-removed',        () => this._rebuild());

        if (this._settings) {
            this._settingsId = this._settings.connect(
                'changed::indicator-show-branches', () => this._rebuild());
        }

        this._rebuild();
        this._installed = true;
        return true;
    }

    uninstall() {
        if (!this._installed) return;

        if (this._activeId)  { this._wm.disconnect(this._activeId);  this._activeId = 0; }
        if (this._addedId)   { this._wm.disconnect(this._addedId);   this._addedId = 0; }
        if (this._removedId) { this._wm.disconnect(this._removedId); this._removedId = 0; }
        if (this._settingsId && this._settings) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }

        if (this._container && this._activitiesBtn &&
            this._container.get_parent() === this._activitiesBtn) {
            this._activitiesBtn.remove_child(this._container);
        }
        this._container?.destroy();
        this._container = null;
        this._columns = [];

        if (this._origIndicator && this._activitiesBtn &&
            !this._origIndicator.get_parent()) {
            this._activitiesBtn.add_child(this._origIndicator);
        }

        this._activitiesBtn = null;
        this._origIndicator = null;
        this._DotClass = null;
        this._installed = false;
    }

    _widthMultiplier(cols) {
        if (cols <= 2) return 3.625;
        if (cols <= 5) return 3.25;
        return 2.75;
    }

    _rebuild() {
        if (!this._container) return;
        this._container.destroy_all_children();
        this._columns = [];

        const t = this._topology;
        const cols = t.mainRowSize;
        if (cols === 0) return;

        const wm = this._widthMultiplier(cols);
        const showBranches = this._settings
            ? this._settings.get_boolean('indicator-show-branches')
            : true;

        for (let c = 0; c < cols; c++) {
            let maxUp = 0, maxDown = 0;
            if (showBranches) {
                for (let l = -1; t.indexAt(c, l) !== null; l--) maxUp = -l;
                for (let l = 1; t.indexAt(c, l) !== null; l++) maxDown = l;
                maxUp   = Math.min(maxUp,   MAX_LAYERS);
                maxDown = Math.min(maxDown, MAX_LAYERS);
            }

            const dot = new this._DotClass();
            dot.widthMultiplier = wm;
            dot.expansion = 0;

            // Без отростков — натив. дот без обёртки.
            if (maxUp === 0 && maxDown === 0) {
                this._container.add_child(dot);
                this._columns.push({ col: c, dot, upStripes: [], downStripes: [], actor: dot });
                continue;
            }

            // upStripes индекс соответствует |layer|: index 0 = layer -maxUp,
            // index maxUp-1 = layer -1 (ближайший к доту).
            const upStripes = [];
            for (let i = 0; i < maxUp; i++) upStripes.push(this._makeStripe());
            const downStripes = [];
            for (let i = 0; i < maxDown; i++) downStripes.push(this._makeStripe());

            const column = new BranchColumn(dot, upStripes, downStripes);
            this._container.add_child(column);
            this._columns.push({ col: c, dot, upStripes, downStripes, actor: column });
        }

        this._updateActive(true);
    }

    _updateActive(immediate) {
        if (this._columns.length === 0) return;

        const t = this._topology;
        const activeIdx = this._wm.get_active_workspace_index();
        const activePos = t.positionOf(activeIdx);
        const activeCol = activePos ? activePos.col : -1;
        const activeLayer = activePos ? activePos.layer : 0;

        for (const e of this._columns) {
            const colActive = e.col === activeCol;
            const targetExp = colActive ? 1 : 0;
            this._easeExpansion(e.dot, targetExp, immediate);

            // upStripes[index] ↔ layer = -(maxUp - index). Ближайший — последний.
            const maxUp = e.upStripes.length;
            for (let i = 0; i < maxUp; i++) {
                const layer = -(maxUp - i);
                const distance = Math.abs(layer);  // 1 — ближайший, 2 — дальний
                const layerActive = colActive && activeLayer === layer;
                const alpha = this._stripeAlpha(distance, layerActive, colActive);
                this._easeStripe(e.upStripes[i], alpha, immediate);
            }
            const maxDown = e.downStripes.length;
            for (let i = 0; i < maxDown; i++) {
                const layer = i + 1;
                const distance = layer;
                const layerActive = colActive && activeLayer === layer;
                const alpha = this._stripeAlpha(distance, layerActive, colActive);
                this._easeStripe(e.downStripes[i], alpha, immediate);
            }
        }
    }

    _stripeAlpha(distance, layerActive, colActive) {
        if (layerActive) return ACTIVE_ALPHA;
        const base = distance === 1 ? NEAR_ALPHA : FAR_ALPHA;
        return colActive ? base : base * INACTIVE_COL_F;
    }

    _easeExpansion(dot, target, immediate) {
        if (immediate) {
            dot.remove_transition('expansion');
            dot.expansion = target;
            return;
        }
        dot.ease_property('expansion', target, {
            duration: ANIM_MS,
            mode: EASE_MODE,
        });
    }

    _easeStripe(stripe, alpha, immediate) {
        const op = Math.round(alpha * 255);
        if (immediate) {
            stripe.remove_all_transitions();
            stripe.opacity = op;
            return;
        }
        stripe.ease({
            duration: ANIM_MS,
            mode: EASE_MODE,
            opacity: op,
        });
    }

    _makeStripe() {
        return new St.Widget({
            opacity: 0,
            style:
                'background-color: rgb(255,255,255);' +
                `border-radius: ${STRIPE_H}px;`,
        });
    }
}
