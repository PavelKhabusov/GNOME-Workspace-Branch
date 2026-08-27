// Свой ThumbnailsBox для overview. Сабкласс оригинального, перекрываем
// только то, что отвечает за 2D раскладку, picking, и DnD создание отростков.
//
// Что override:
//   - vfunc_get_preferred_width  → ширина по mainRowSize, не по nThumbnails
//   - vfunc_get_preferred_height → учитывает максимальную глубину отростков
//   - vfunc_allocate             → раскладка (col, layer) из topology
//   - _activateThumbnailAtPoint  → 2D pick, чтобы клик попадал в отростки
//   - handleDragOver / acceptDrop → drop zones сверху/снизу колонок;
//                                   на drop вызываем ops.create(col, dir)
//   - _clearDragPlaceholder      → сброс _dropMode/_dropCol

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ThumbnailsBox } from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

const WORKSPACE_CUT_SIZE = 10;
const ParentProto = ThumbnailsBox.prototype;

function layerExtents(t) {
    let maxUp = 0, maxDown = 0;
    for (let c = 0; c < t.mainRowSize; c++) {
        for (let l = -1; t.indexAt(c, l) !== null; l--)
            if (-l > maxUp) maxUp = -l;
        for (let l = 1; t.indexAt(c, l) !== null; l++)
            if (l > maxDown) maxDown = l;
    }
    return { maxUp, maxDown };
}

export const GridThumbnailsBox = GObject.registerClass(
class GridThumbnailsBox extends ThumbnailsBox {
    _init(scrollAdjustment, monitorIndex, topology, ops, settings) {
        super._init(scrollAdjustment, monitorIndex);
        this._topology = topology;
        this._ops = ops;
        // Нативный ThumbnailsBox внутри super._init выставляет this._settings
        // на org.gnome.mutter и слушает на нём 'dynamic-workspaces' — не
        // затирать! Наши собственные настройки храним под другим именем.
        this._wbSettings = settings ?? null;
        this._dropMode = 'none'; // 'none' | 'col-up' | 'col-down' | 'main-end' | 'main-insert'
        this._dropCol  = -1;

        // Собственный placeholder для col-up/col-down — наследуемый _dropPlaceholder
        // стилизован как тонкая вертикальная полоска (для разрыва между thumbnails);
        // нам нужен прямоугольник размера thumbnail.
        this._gridPlaceholder = new St.Widget({
            style: 'background-color: rgba(255,255,255,0.18); ' +
                   'border: 2px solid rgba(255,255,255,0.55); border-radius: 4px;',
            visible: false,
            reactive: false,
        });
        this.add_child(this._gridPlaceholder);
    }

    // ControlsManagerLayout кэпит thumbnailsHeight по height * maxThumbnailScale.
    // Дефолт 0.05 — место только под 1 ряд. Возвращаем rows * 0.05 чтобы шелл
    // дал нам полную высоту под все ряды; workspaces display под нами сожмётся.
    get maxThumbnailScale() {
        const t = this._topology;
        if (!t || t.mainRowSize === 0)
            return this._maxThumbnailScale;
        const { maxUp, maxDown } = layerExtents(t);
        return this._maxThumbnailScale * (1 + maxUp + maxDown);
    }

    vfunc_get_preferred_width(forHeight) {
        const t = this._topology;
        if (!t || t.mainRowSize === 0)
            return ParentProto.vfunc_get_preferred_width.call(this, forHeight);
        const themeNode = this.get_theme_node();
        const spacing = themeNode.get_length('spacing');
        const cols = t.mainRowSize;
        const totalSpacing = (cols - 1) * spacing;
        const naturalWidth = cols * this._porthole.width * this._maxThumbnailScale + totalSpacing;
        return themeNode.adjust_preferred_width(totalSpacing, naturalWidth);
    }

    vfunc_get_preferred_height(forWidth) {
        const t = this._topology;
        if (!t || t.mainRowSize === 0)
            return ParentProto.vfunc_get_preferred_height.call(this, forWidth);
        const themeNode = this.get_theme_node();
        forWidth = themeNode.adjust_for_width(forWidth);
        const spacing = themeNode.get_length('spacing');
        const cols = t.mainRowSize;
        const totalSpacing = (cols - 1) * spacing;
        const avail = forWidth - totalSpacing;
        let scale = (avail / cols) / this._porthole.width;
        scale = Math.min(scale, this._maxThumbnailScale);
        const oneH = Math.round(this._porthole.height * scale);
        // Запрашиваем высоту под main row + все отростки сверху и снизу,
        // чтобы они помещались в allocation и не вытекали на search bar.
        // Workspaces display ниже сожмётся пропорционально.
        const { maxUp, maxDown } = layerExtents(t);
        const rows = 1 + maxUp + maxDown;
        const totalH = oneH * rows + (rows - 1) * spacing;
        return themeNode.adjust_preferred_height(totalH, totalH);
    }

    vfunc_allocate(box) {
        const t = this._topology;
        if (!t || t.mainRowSize === 0 || this._thumbnails.length === 0) {
            ParentProto.vfunc_allocate.call(this, box);
            return;
        }

        this.set_allocation(box);
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const themeNode = this.get_theme_node();
        const cBox = themeNode.get_content_box(box);
        const portholeW = this._porthole.width;
        const portholeH = this._porthole.height;
        const spacing = themeNode.get_length('spacing');

        const cols = t.mainRowSize;
        const { maxUp, maxDown } = layerExtents(t);
        const rows = 1 + maxUp + maxDown;
        const totalSpacingX = (cols - 1) * spacing;
        const totalSpacingY = (rows - 1) * spacing;
        const boxW = cBox.x2 - cBox.x1;
        const boxH = cBox.y2 - cBox.y1;

        // Вырожденный box во время анимации — на нативную раскладку, иначе
        // availW/availH ниже дают отрицательный scale и thumbnails мерцают.
        if (boxW <= 1 || boxH <= 1) {
            ParentProto.vfunc_allocate.call(this, box);
            return;
        }

        // Scale: width-based (как для одного ряда), но cap'нутый по доступной
        // высоте делённой на rows — иначе при большой allocation thumbs
        // окажутся гигантскими.
        if (this._expandFraction === 0 || this._expandFraction === 1) {
            const availW = (boxW - totalSpacingX) / cols;
            const availH = (boxH - totalSpacingY) / rows;
            const newScale = Math.min(availW / portholeW, availH / portholeH, this._maxThumbnailScale);
            if (newScale !== this._targetScale) {
                if (this._targetScale > 0) {
                    this._targetScale = newScale;
                    this._pendingScaleUpdate = true;
                } else {
                    this._targetScale = this._scale = newScale;
                }
                this._queueUpdateStates();
            }
        }

        const ratio = portholeW / portholeH;
        const thumbFullH = Math.round(portholeH * this._scale);
        const thumbW = Math.round(thumbFullH * ratio);
        const thumbH = thumbFullH * this._expandFraction;
        const roundedHScale = thumbW / portholeW;
        const roundedVScale = thumbH / portholeH;

        const usedW = cols * thumbW + totalSpacingX;
        const usedH = rows * thumbH + totalSpacingY;
        const baseX = cBox.x1 + Math.max(0, (boxW - usedW) / 2);
        const baseY = cBox.y1 + Math.max(0, (boxH - usedH) / 2);
        const mainY = baseY + maxUp * (thumbH + spacing);

        const childBox = new Clutter.ActorBox();
        const activeIdx = global.workspace_manager.get_active_workspace_index();
        let indX1 = 0, indX2 = 0, indY1 = 0, indY2 = 0;

        for (let i = 0; i < this._thumbnails.length; i++) {
            const thumb = this._thumbnails[i];
            const pos = t.positionOf(i);
            if (!pos) {
                childBox.x1 = -10000; childBox.x2 = -9999;
                childBox.y1 = -10000; childBox.y2 = -9999;
                thumb.setScale(roundedHScale, roundedVScale);
                thumb.allocate(childBox);
                continue;
            }
            const { col, layer } = pos;
            let x1 = Math.round(baseX + col * (thumbW + spacing));
            const y1 = Math.round(mainY + layer * (thumbH + spacing));
            if (rtl) x1 = cBox.x2 - (x1 - cBox.x1) - thumbW;

            childBox.x1 = x1; childBox.x2 = x1 + thumbW;
            childBox.y1 = y1; childBox.y2 = y1 + thumbH;
            thumb.setScale(roundedHScale, roundedVScale);
            thumb.allocate(childBox);

            if (i === activeIdx) {
                indX1 = childBox.x1; indX2 = childBox.x2;
                indY1 = childBox.y1; indY2 = childBox.y2;
            }
        }

        // Indicator активного — на правильной (col, layer) клетке.
        const inNode = this._indicator.get_theme_node();
        const padT = inNode.get_padding(St.Side.TOP)    + inNode.get_border_width(St.Side.TOP);
        const padB = inNode.get_padding(St.Side.BOTTOM) + inNode.get_border_width(St.Side.BOTTOM);
        const padL = inNode.get_padding(St.Side.LEFT)   + inNode.get_border_width(St.Side.LEFT);
        const padR = inNode.get_padding(St.Side.RIGHT)  + inNode.get_border_width(St.Side.RIGHT);
        childBox.x1 = indX1 - padL;
        childBox.x2 = indX2 + padR;
        childBox.y1 = indY1 - padT;
        childBox.y2 = indY2 + padB;
        this._indicator.allocate(childBox);

        // Унаследованный _dropPlaceholder используем только для main-end
        // (тонкая полоска справа от последней main-колонки). Для col-up/col-down
        // используем наш _gridPlaceholder (rectangle размера thumbnail).
        let showOrigPlaceholder = false;
        let showGridPlaceholder = false;

        if (this._dropMode === 'col-up' && this._dropCol >= 0 && this._dropCol < cols) {
            const px = Math.round(baseX + this._dropCol * (thumbW + spacing));
            let depth = 0;
            for (let l = -1; t.indexAt(this._dropCol, l) !== null; l--) depth++;
            const py = mainY - (depth + 1) * (thumbH + spacing);
            childBox.x1 = px; childBox.x2 = px + thumbW;
            childBox.y1 = py; childBox.y2 = py + thumbH;
            this._gridPlaceholder.allocate(childBox);
            showGridPlaceholder = true;
        } else if (this._dropMode === 'col-down' && this._dropCol >= 0 && this._dropCol < cols) {
            const px = Math.round(baseX + this._dropCol * (thumbW + spacing));
            let depth = 0;
            for (let l = 1; t.indexAt(this._dropCol, l) !== null; l++) depth++;
            const py = mainY + (depth + 1) * (thumbH + spacing);
            childBox.x1 = px; childBox.x2 = px + thumbW;
            childBox.y1 = py; childBox.y2 = py + thumbH;
            this._gridPlaceholder.allocate(childBox);
            showGridPlaceholder = true;
        } else if (this._dropMode === 'main-end') {
            // Полоска справа от последней main колонки. Размер согласно
            // preferred width оригинального placeholder.
            const [, plW] = this._dropPlaceholder.get_preferred_width(-1);
            const px = Math.round(baseX + cols * (thumbW + spacing) - spacing);
            childBox.x1 = px;            childBox.x2 = px + plW;
            childBox.y1 = mainY;         childBox.y2 = mainY + thumbH;
            this._dropPlaceholder.allocate(childBox);
            showOrigPlaceholder = true;
        } else if (this._dropMode === 'main-insert' &&
                   this._dropCol >= 0 && this._dropCol < cols) {
            // Полоска у левого края колонки _dropCol — сюда встанет новая колонка.
            const [, plW] = this._dropPlaceholder.get_preferred_width(-1);
            const px = Math.round(baseX + this._dropCol * (thumbW + spacing) - plW);
            childBox.x1 = px;            childBox.x2 = px + plW;
            childBox.y1 = mainY;         childBox.y2 = mainY + thumbH;
            this._dropPlaceholder.allocate(childBox);
            showOrigPlaceholder = true;
        }

        if (!showGridPlaceholder && this._gridPlaceholder.visible)
            this._gridPlaceholder.hide();
        if (showGridPlaceholder && !this._gridPlaceholder.visible)
            this._gridPlaceholder.show();

        if (!showOrigPlaceholder) {
            this._dropPlaceholder.allocate_preferred_size(
                ...this._dropPlaceholder.get_position());
            this._clearDropPlaceholderLater();
            if (this._dropPlaceholder.visible) {
                const laters = global.compositor.get_laters();
                this._dropPlaceholderLater = laters.add(
                    Meta.LaterType.BEFORE_REDRAW, () => {
                        this._dropPlaceholder.hide();
                        delete this._dropPlaceholderLater;
                        return GLib.SOURCE_REMOVE;
                    });
            }
        } else {
            this._clearDropPlaceholderLater();
            if (!this._dropPlaceholder.visible) {
                const laters = global.compositor.get_laters();
                this._dropPlaceholderLater = laters.add(
                    Meta.LaterType.BEFORE_REDRAW, () => {
                        this._dropPlaceholder.show();
                        delete this._dropPlaceholderLater;
                        return GLib.SOURCE_REMOVE;
                    });
            }
        }
    }

    _activateThumbnailAtPoint(x, y, time) {
        const found = this._thumbnails.find(thumb => {
            const a = thumb.allocation;
            return a && x >= a.x1 && x <= a.x2 && y >= a.y1 && y <= a.y2;
        });
        if (!found) return;
        // В drum-режиме клик по отростку должен вращать колонку, а не просто
        // активировать его — иначе пользователь оказывается на appendage,
        // а инвариант «активный всегда в main row» ломается.
        if (this._wbSettings?.get_boolean('drum-rotation')) {
            const idx = found.metaWorkspace?.index?.();
            const pos = typeof idx === 'number' ? this._topology.positionOf(idx) : null;
            if (pos && pos.layer !== 0) {
                const direction = pos.layer > 0 ? 'down' : 'up';
                const steps = Math.abs(pos.layer);
                for (let i = 0; i < steps; i++) {
                    if (!this._ops.rotateColumn(pos.col, direction)) break;
                }
            }
        }
        found.activate(time);
    }

    handleDragOver(source, actor, x, y, time) {
        if (!source.metaWindow &&
            (!source.app || !source.app.can_open_new_window()) &&
            (source.app || !source.shellWorkspaceLaunch) &&
            source !== Main.xdndHandler)
            return DND.DragMotionResult.CONTINUE;

        const t = this._topology;
        if (!t || t.mainRowSize === 0)
            return DND.DragMotionResult.CONTINUE;

        // Внутри существующего thumbnail — обычный drag-over.
        for (let i = 0; i < this._thumbnails.length; i++) {
            const thumb = this._thumbnails[i];
            const a = thumb.allocation;
            if (!a) continue;
            const inside = x > a.x1 + WORKSPACE_CUT_SIZE && x < a.x2 - WORKSPACE_CUT_SIZE &&
                           y > a.y1 + WORKSPACE_CUT_SIZE && y < a.y2 - WORKSPACE_CUT_SIZE;
            if (inside) {
                this._dropWorkspace = i;
                if (this._dropMode !== 'none') {
                    this._dropMode = 'none';
                    this._dropCol = -1;
                    this.queue_relayout();
                }
                return thumb.handleDragOverInternal(source, actor, time);
            }
        }
        this._dropWorkspace = -1;

        // Drop zone сверху/снизу колонок главного ряда + справа от последней колонки.
        const mainFirst = this._thumbnails[0];
        if (!mainFirst || !mainFirst.allocation)
            return DND.DragMotionResult.CONTINUE;
        const a0 = mainFirst.allocation;
        const w = a0.x2 - a0.x1;
        const h = a0.y2 - a0.y1;
        const themeNode = this.get_theme_node();
        const spacing = themeNode.get_length('spacing');
        const baseX = a0.x1;
        const mainY = a0.y1;

        // 1) col-up / col-down — над/под колонкой
        for (let c = 0; c < t.mainRowSize; c++) {
            const cx1 = baseX + c * (w + spacing);
            const cx2 = cx1 + w;
            if (x < cx1 || x > cx2) continue;

            let mode = 'none';
            if (y < mainY) mode = 'col-up';
            else if (y > mainY + h) mode = 'col-down';

            if (mode === 'none') break;

            if (this._dropMode !== mode || this._dropCol !== c) {
                this._dropMode = mode;
                this._dropCol = c;
                this.queue_relayout();
            }
            return source.metaWindow
                ? DND.DragMotionResult.MOVE_DROP
                : DND.DragMotionResult.COPY_DROP;
        }

        // 2) main-insert — вставка новой колонки СЛЕВА от колонки c (у левого
        // края её thumbnail). Колонки c.. сдвигаются вправо, отростки и
        // window-rules переиндексируются. _dropCol здесь = позиция вставки.
        for (let c = 0; c < t.mainRowSize; c++) {
            const cx1 = baseX + c * (w + spacing);
            if (y < mainY || y > mainY + h) continue;
            if (x >= cx1 - WORKSPACE_CUT_SIZE && x <= cx1 + WORKSPACE_CUT_SIZE) {
                if (this._dropMode !== 'main-insert' || this._dropCol !== c) {
                    this._dropMode = 'main-insert';
                    this._dropCol = c;
                    this.queue_relayout();
                }
                return source.metaWindow
                    ? DND.DragMotionResult.MOVE_DROP
                    : DND.DragMotionResult.COPY_DROP;
            }
        }

        // 3) main-end — расширение главного ряда новой колонкой справа.
        const lastIdx = t.mainRowSize - 1;
        const lastA = this._thumbnails[lastIdx]?.allocation;
        if (lastA && y >= lastA.y1 && y <= lastA.y2 &&
            x > lastA.x2 - WORKSPACE_CUT_SIZE &&
            x <= lastA.x2 + spacing + WORKSPACE_CUT_SIZE * 2) {
            if (this._dropMode !== 'main-end') {
                this._dropMode = 'main-end';
                this._dropCol = -1;
                this.queue_relayout();
            }
            return source.metaWindow
                ? DND.DragMotionResult.MOVE_DROP
                : DND.DragMotionResult.COPY_DROP;
        }

        if (this._dropMode !== 'none') {
            this._dropMode = 'none';
            this._dropCol = -1;
            this.queue_relayout();
        }
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, actor, x, y, time) {
        if (this._dropWorkspace !== -1)
            return this._thumbnails[this._dropWorkspace].acceptDropInternal(source, actor, time);

        if (this._dropMode === 'none') return false;
        if (!source.metaWindow &&
            (!source.app || !source.app.can_open_new_window()) &&
            (source.app || !source.shellWorkspaceLaunch))
            return false;

        let newIdx;
        if (this._dropMode === 'main-end') {
            // Расширяем главный ряд новой колонкой справа. Mutter
            // вставит воркспейс на позицию = текущий mainRowSize, отростки
            // линейно сдвинутся вправо. topology.onWorkspaceAdded увеличит
            // mainRowSize, _appendages останутся прежние.
            newIdx = this._topology.mainRowSize;
            Main.wm.insertWorkspace(newIdx);
        } else if (this._dropMode === 'main-insert') {
            // Вставка колонки СЛЕВА от _dropCol: колонки правее сдвигаются,
            // window-rules переиндексируются внутри ops.insertMainColumn.
            const at = this._dropCol;
            if (at < 0) return false;
            newIdx = this._ops.insertMainColumn(at);
        } else if (this._dropMode === 'col-up' || this._dropMode === 'col-down') {
            if (this._dropCol < 0) return false;
            const dir = this._dropMode === 'col-up' ? 'up' : 'down';
            newIdx = this._ops.create(this._dropCol, dir);
        } else {
            return false;
        }
        this._dropMode = 'none';
        this._dropCol = -1;
        if (newIdx === null || newIdx === undefined) return false;

        const ws = global.workspace_manager.get_workspace_by_index(newIdx);
        if (source.metaWindow) {
            if (ws) source.metaWindow.change_workspace_by_index(newIdx, false);
        } else if (source.app && source.app.can_open_new_window()) {
            if (source.animateLaunchAtPos)
                source.animateLaunchAtPos(actor.x, actor.y);
            source.app.open_new_window(newIdx);
        }
        if (ws) ws.activate(global.get_current_time());
        return true;
    }

    _clearDragPlaceholder() {
        this._dropMode = 'none';
        this._dropCol = -1;
        ParentProto._clearDragPlaceholder.call(this);
    }
});
