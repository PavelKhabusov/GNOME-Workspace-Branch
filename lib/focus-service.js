// D-Bus surface for raising/focusing windows from outside the shell —
// callers (home-kit-dash, scripts) can ask the extension to bring a
// matching window to the foreground, bypassing Wayland's focus-stealing
// prevention which otherwise turns external `code <path>` invocations
// into mere taskbar badges.
//
// All methods take a timestamp of `global.get_current_time()` and use
// `window.activate(timestamp)` so Mutter accepts the request as a
// user-initiated focus change.

import Gio from 'gi://Gio';

const IFACE = `
<node>
  <interface name="dev.pavel.WorkspaceBranch.Focus">
    <!-- Focus the first window whose wm_class matches \`cls\`.
         Returns true on success. -->
    <method name="FocusByClass">
      <arg type="s" direction="in" name="cls"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <!-- Focus the window that best matches \`needle\` (case-insensitive).
         Editor titles read "<file> - <project> - App", so an exact
         "<project>" segment wins over a mere substring. Pass \`cls\` to
         restrict the search to one app (empty string = any window), which
         keeps a browser tab named after the project from stealing the
         match. Returns true on success. -->
    <method name="FocusByTitle">
      <arg type="s" direction="in" name="needle"/>
      <arg type="s" direction="in" name="cls"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <!-- Try title match first, fall back to class match. Designed for
         the home-kit-dash "Open in VS Code" action: pass the workspace
         basename + the app's wm_class. Returns true on success. -->
    <method name="FocusByTitleOrClass">
      <arg type="s" direction="in" name="needle"/>
      <arg type="s" direction="in" name="cls"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <!-- Politely close the first window whose title contains \`needle\`,
         falling back to class match. Uses Meta.Window.delete() so the app
         gets WM_DELETE and can prompt about unsaved changes. -->
    <method name="CloseByTitleOrClass">
      <arg type="s" direction="in" name="needle"/>
      <arg type="s" direction="in" name="cls"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <!-- List visible windows as JSON [{id, class, title, focused}]. Debug aid. -->
    <method name="ListWindows">
      <arg type="s" direction="out" name="json"/>
    </method>
  </interface>
</node>`;

const PATH = '/dev/pavel/WorkspaceBranch/Focus';

export class FocusService {
    constructor() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
    }

    enable() {
        try {
            this._dbus.export(Gio.DBus.session, PATH);
            console.log(`[workspace-branch] focus service exported at ${PATH}`);
        } catch (e) {
            console.warn(`[workspace-branch] focus service export failed: ${e}`);
        }
    }

    disable() {
        try { this._dbus.unexport(); } catch { /* ignore */ }
    }

    // Returns the array of [Meta.Window] currently known to Mutter, newest first.
    _windows() {
        return global.get_window_actors()
            .map(a => a.meta_window)
            .filter(w => !!w);
    }

    _activate(win) {
        const ws = win.get_workspace();
        const ts = global.get_current_time();
        if (ws && global.workspace_manager.get_active_workspace() !== ws) {
            ws.activate(ts);
        }
        if (win.minimized) win.unminimize();
        win.activate(ts);
        // raise() ensures the window is at the top of the WM stack even when
        // activate() alone wasn't enough (e.g. another app held focus very
        // recently and Mutter is in focus-stealing-prevention mode).
        win.raise();
    }

    FocusByClass(cls) {
        const target = cls?.toLowerCase();
        if (!target) return false;
        for (const w of this._windows()) {
            const wc = (w.get_wm_class() || '').toLowerCase();
            if (wc === target) {
                this._activate(w);
                return true;
            }
        }
        return false;
    }

    // Editors title their windows "<file> - <project> - Visual Studio Code",
    // so the project name is its own " - "-separated segment. Matching that
    // segment exactly beats a substring test: "IMV" used to grab whatever
    // else happened to carry the word (a browser tab, a chat), and short
    // names matched half the desktop.
    _titleSegments(w) {
        return (w.get_title() || '')
            .toLowerCase()
            .split(/\s[-—]\s/)
            .map(s => s.trim())
            .filter(Boolean);
    }

    _rank(w, needle, cls) {
        const segs = this._titleSegments(w);
        const classMatches = !cls || (w.get_wm_class() || '').toLowerCase() === cls;
        // An exact segment in the right app is the only unambiguous hit.
        if (segs.includes(needle)) return classMatches ? 3 : 1;
        if (!classMatches) return 0;
        // Same app, name appears somewhere in the title — good enough when
        // nothing matched exactly (e.g. a renamed workspace).
        return segs.some(s => s.includes(needle)) ? 2 : 0;
    }

    /** Focus the best window for `needle`; `cls` (optional) restricts the
     *  search to one app so unrelated windows can't win the match. */
    FocusByTitle(needle, cls) {
        const n = needle?.toLowerCase();
        if (!n) return false;
        const c = cls?.toLowerCase() || '';
        let best = null;
        let bestRank = 0;
        for (const w of this._windows()) {
            const rank = this._rank(w, n, c);
            // Prefer a higher rank; among equals keep the first (newest).
            if (rank > bestRank) {
                best = w;
                bestRank = rank;
            }
        }
        if (!best) return false;
        this._activate(best);
        return true;
    }

    FocusByTitleOrClass(needle, cls) {
        return this.FocusByTitle(needle, cls) || this.FocusByClass(cls);
    }

    CloseByTitleOrClass(needle, cls) {
        const n = needle?.toLowerCase();
        const c = cls?.toLowerCase();
        if (n) {
            let best = null;
            let bestRank = 0;
            for (const w of this._windows()) {
                const rank = this._rank(w, n, c || '');
                if (rank > bestRank) {
                    best = w;
                    bestRank = rank;
                }
            }
            if (best) {
                best.delete(global.get_current_time());
                return true;
            }
        }
        // Title didn't match — try class. Picks the first window of that
        // class, which is fine when the caller only has one such window
        // open; otherwise prefer the title-based call.
        for (const w of this._windows()) {
            const wc = (w.get_wm_class() || '').toLowerCase();
            if (c && wc === c) {
                w.delete(global.get_current_time());
                return true;
            }
        }
        return false;
    }

    ListWindows() {
        const out = this._windows().map(w => ({
            id: w.get_id(),
            class: w.get_wm_class() || '',
            title: w.get_title() || '',
            focused: w.has_focus(),
            workspace: w.get_workspace()?.index() ?? -1,
        }));
        return JSON.stringify(out);
    }
}
