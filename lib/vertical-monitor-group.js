// Сабкласс MonitorGroup, который перекладывает workspace_groups вертикально
// и анимирует progress по оси Y. Используется в animateSwitch и VerticalSwipe.
//
// Не объявляем Properties: { progress } повторно — иначе GObject конфликтует
// с родительской ParamSpec и set/get может идти по parent setter (container.x).
// JS-override getter/setter у нас наследуется напрямую, и notify('progress')
// вручную поддерживает binding.

import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { MonitorGroup, WorkspaceBackground, WORKSPACE_SPACING } from
    'resource:///org/gnome/shell/ui/workspaceAnimation.js';

export const VerticalMonitorGroup = GObject.registerClass(
class VerticalMonitorGroup extends MonitorGroup {
    _init(monitor, workspaceIndices, movingWindow) {
        super._init(monitor, workspaceIndices, movingWindow);

        // Backdrop = wallpaper текущего workspace + blur поверх. В gap между
        // WG-группами видно blurred wallpaper, а не overlying current ws content.
        const activeWs = global.workspace_manager.get_active_workspace();
        this._verticalBackdrop = new WorkspaceBackground(activeWs, monitor);
        try {
            const eff = new Shell.BlurEffect({
                brightness: 1,
                mode: Shell.BlurMode.ACTOR,
            });
            if ('radius' in eff)      eff.radius = 30;
            else if ('sigma' in eff)  eff.sigma = 30;
            this._verticalBackdrop.add_effect(eff);
        } catch (e) {
            console.warn(`[workspace-branch] Shell.BlurEffect unavailable: ${e.message}`);
        }
        this.insert_child_below(this._verticalBackdrop, this._container);

        const spacing = WORKSPACE_SPACING * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let y = 0;
        for (const group of this._workspaceGroups) {
            group.set_position(0, y);
            y += monitor.height + spacing;
        }

        this.progress = this.getWorkspaceProgress(activeWs);
    }

    get baseDistance() {
        const spacing = WORKSPACE_SPACING * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return this._monitor.height + spacing;
    }

    get progress() {
        return -this._container.y / this.baseDistance;
    }

    set progress(p) {
        this._container.y = -Math.round(p * this.baseDistance);
        this.notify('progress');
    }

    _getWorkspaceGroupProgress(group) {
        return group.y / this.baseDistance;
    }
});
