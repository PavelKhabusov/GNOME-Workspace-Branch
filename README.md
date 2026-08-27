<div align="center">

<img src="assets/icon.svg" width="96" alt="GNOME Workspace Branch">

# GNOME Workspace Branch

**Optional vertical “appendages” for the horizontal workspace row.** Your main row stays exactly
as configured — Auto Move Windows and index-based bindings keep working — and every column can grow up and down.

![Status](https://img.shields.io/badge/status-active-2ea043)
![Platform](https://img.shields.io/badge/platform-Linux%20%C2%B7%20Wayland-1f1f1f)
![License](https://img.shields.io/badge/license-MIT-7ba7d4)

![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-50-4A86CF?logo=gnome&logoColor=white)
![Mutter](https://img.shields.io/badge/Mutter-50-2CA5E0)
![GJS](https://img.shields.io/badge/GJS-ESM-F7DF1E?logo=javascript&logoColor=black)

</div>

---

```
                      [up_2]
                        |
          [up_1]      [up_1]
            |           |
      WS0 -- WS1 -- WS2 -- WS3 -- WS4   <-- main row, untouched
                        |
                      [dn_1]
```

## Highlights

- **Main row is sacred** — appendages are appended at the end of Mutter's
  linear list, so AMW indices `1..N` keep pointing at the right workspace.
- **2D keyboard navigation** — `Super + ←/→/↑/↓` moves through the grid.
- **3-finger touchpad** — horizontal swipe for native left/right (clamped to
  main row), vertical swipe for our up/down.
- **4-finger ladder** — up opens overview → app grid; down closes.
- **Vertical slide animation** — switching between main and appendage of the
  same column animates with a real vertical slide (own `MonitorGroup`
  subclass), with a blurred wallpaper backdrop in the gap.
- **Overview integration** — own `ThumbnailsBox` subclass renders appendages
  above/below their column with full DnD: drop a window over a column to
  create a new appendage there. Drop at the right end to extend the main row.
- **App Grid 2D** — the workspaces preview in App Grid mode is laid out as a
  proper grid (cols × layers), not a single horizontal strip.
- **Branched indicator** — instead of a separate panel button, the native
  Activities preview is replaced with a 2D variant: native dots for the main
  row + small "appendage stripes" stuck above/below them. Falls back to a
  classic standalone indicator if Activities is unavailable.
- **Drum-rotation mode** (opt-in) — `Super+Up/Down` rotates the active
  column like a slot-machine drum so a different appendage becomes the new
  main, instead of navigating. Active workspace stays on the main row;
  Mutter is reindexed to keep linear order consistent.
- **Window routing** (Auto-Move-Windows-style + 2D) — per-app rules send
  newly created windows to a target `(col, layer)`. Match by `.desktop` id
  (picked from the native `Gtk.AppChooserDialog`), `wm_class`, regex
  `title`, or `pid_comm` (process name from `/proc/<pid>/comm`).
  - **Auto-create**: targets past the current edge auto-extend the main row
    and auto-create appendages — no need to set up topology first.
  - **Stack mode**: each next window of the same app drops one layer
    deeper (`+1`, `+2`, …). Open three VS Code projects → three workspaces
    in a single column.
  - **Per-rule autostart**: toggle launches the app once per session via
    `Shell.App.activate()`, with a fallback to the `.desktop`'s `Exec=` if
    activate doesn't materialise a window.
  - **Layout preview** in prefs — a small grid that shows where each rule
    will land. Drag any icon to retarget it without touching the spinners.
- **Auto-cleanup** — empty appendages disappear on switch / window close.
  Empty main columns can also retire (no appendages, ≥ 1 column remains),
  with the topology re-indexing surviving columns automatically.
- **Persists** — appendage layout is saved in gsettings and restored after
  shell restart / Wayland re-login.

## Requirements

- Linux with **GNOME Shell 50** (Wayland tested; X11 should also work).
- That's it. No external services, no other extensions required.

## Install

```bash
git clone https://github.com/pavelkhabusov/gnome-workspace-branch.git
cd gnome-workspace-branch
make install
```

Then **log out and log back in** (Wayland scans extensions only at shell
startup) and enable:

```bash
gnome-extensions enable workspace-branch@pavel.local
```

Or just toggle it via Extensions app.

### Manual install

```bash
make compile-schemas
mkdir -p ~/.local/share/gnome-shell/extensions/workspace-branch@pavel.local
cp -r metadata.json extension.js prefs.js lib schemas \
      ~/.local/share/gnome-shell/extensions/workspace-branch@pavel.local/
```

## Default keybindings

| Action                          | Shortcut                    |
| ------------------------------- | --------------------------- |
| Switch up / down                | `Super + Up/Down`           |
| Switch left / right (main row)  | `Super + Left/Right`        |
| Create appendage above / below  | `Super + Ctrl + Up/Down`    |
| Extend main row (new column)    | `Super + Ctrl + Right`      |
| Move window up / down           | `Super + Shift + Up/Down`   |
| Move window left / right        | `Super + Shift + Left/Right`|
| Remove current appendage        | `Super + Ctrl + Shift + ⌫`  |

All bindings are configurable in **Extension preferences**
(`gnome-extensions prefs workspace-branch@pavel.local`).

## Touchpad gestures

- **3 fingers horizontal** → switch left/right within the main row (native).
- **3 fingers vertical** → switch up/down through the active column's stack
  (with a smooth vertical slide and blurred wallpaper in the gap).
- **4 fingers up** → enter overview, again → enter app grid.
- **4 fingers down** → step back down the same ladder.
- **Super + scroll** anywhere — same as 3-finger vertical (works with mouse
  wheel too).
- **Scroll over the panel** — same.

## Compatibility with Auto Move Windows

[Auto Move Windows](https://gitlab.gnome.org/GNOME/gnome-shell-extensions)
reads `org.gnome.shell.extensions.auto-move-windows application-list` —
pairs of `app.desktop:N` where `N` is a 1-based linear index. This extension:

1. Never reorders the main row in default mode, so indices `1..N` keep their
   meaning. (Drum-rotation mode does reindex, opt-in only.)
2. Appends appendages **at the end** of Mutter's list (`N+1`, `N+2`, …) where
   AMW doesn't look.
3. Removes only appendages by index unless its main column has no
   appendages and the row would still be non-empty, in which case the
   topology shrinks main row in a way AMW indices naturally follow.

You don't need to change a single byte of your AMW configuration to keep it
working alongside this extension. If you want to **switch entirely to our
routing**, the built-in rule editor covers everything AMW does (pick app
from the system list, set workspace) plus 2D targets, regex matching, stack
mode, and autostart.

## Architecture

```
extension.js         # ESM Extension class, enable/disable, signal wiring
prefs.js             # Adw preferences (keybindings, behavior, rules editor,
                     # layout preview with DnD)
lib/
  topology.js        # ColumnTopology — single source of truth (col, layer);
                     # rotation, removeMainColumn, columnHasAppendages
  navigator.js       # switchUp/Down/Left/Right, moveWindow*, removeCurrent;
                     # drum-rotation dispatch when 'drum-rotation' is on
  workspaces.js      # CRUD over Mutter (append + reorder for static-mode
                     # extends, removeMainColumn, rotateColumn)
  keybindings.js     # Meta keybinding registration
  system-keys.js     # release conflicting native shortcuts on enable
  indicator.js       # standalone panel mini-map (used as fallback)
  branched-indicator.js
                     # native Activities preview replacement: dots + stripes
  swipes.js          # 4F touchpad ladder + Super+scroll + panel scroll
  vertical-swipe.js  # 3F vertical swipe (own SwipeTracker over column stack)
  vertical-monitor-group.js
                     # MonitorGroup subclass for vertical slide animation
  animation-patch.js # patches Main.wm._workspaceAnimation for our cases
  grid-thumbnails-box.js
                     # ThumbnailsBox subclass — 2D layout + DnD zones
  workspaces-view-patch.js
                     # WorkspacesView swap — 2D layout in overview
  overview-patch.js  # swap _thumbnailsBox in overview controls
  auto-cleanup.js    # remove empty appendages and main columns; chain prune
  window-rules.js    # routing engine: matches windows on display::
                     # window-created and moves them to (col, layer); auto-
                     # extends main row and auto-creates appendages; stack mode
  autostart.js       # per-rule autostart: Shell.App.activate() / launch() /
                     # Gio.Subprocess fallback; once per session
schemas/
  org.gnome.shell.extensions.workspace-branch.gschema.xml
metadata.json        # shell-version: ["50"]
Makefile             # install / pack / test
tests/
  topology-test.js   # standalone gjs unit tests for the topology layer
                     # (load, neighbor, register/unregister, columnHas-
                     # Appendages, removeMainColumn, computeRotation, …)
```

The model is a small, testable core (`Topology`) plus a set of GNOME Shell
patches that make the rest of the shell aware of (col, layer):

- `Topology` keeps an array of appendages in the order they appear in
  Mutter's linear list. Linear index `mainRowSize + i` → `appendages[i]`. No
  index bookkeeping on `workspace-removed`.
- `GridThumbnailsBox` and `GridWorkspacesView` are full subclasses of the
  shell's classes, registered with `GObject.registerClass`, swapped in via
  `Main.overview._overview._controls`.
- `VerticalMonitorGroup` is a subclass of the shell's `MonitorGroup` with
  y-axis layout, used both by `animateSwitch` and by our own SwipeTracker.

## Run the tests

```bash
make test
```

Pure-logic tests for the topology layer run under stock `gjs` with mocked
`global.workspace_manager` and `Gio.Settings`. No GNOME session needed.

## Development

```bash
# build + install to ~/.local/share/...
make install

# reload (no logout needed for most JS changes)
gnome-extensions disable workspace-branch@pavel.local && \
gnome-extensions enable workspace-branch@pavel.local

# watch the journal for our logs
journalctl --user -b 0 _COMM=gnome-shell -n 100 | grep -i workspace-branch
```

For deep changes to overview integration, **log out and log back in** —
Wayland only scans the extension dir at shell start, and some classes can
get stuck in an old GType state otherwise.

## Limitations / known gaps

- DnD into a column-up/down zone in overview only works above existing
  thumbnails strip area; reaching above/below the strip requires a
  drop-catcher actor that's not yet implemented.
- `_workspacesAdjustment` linear lerp is used for swipe progress — between
  far-apart appendages this can produce a brief diagonal slide when shell
  smoothly eases the value through intermediate indices.
- Topology is global, not per-monitor.
- GJS caches ES modules across `gnome-extensions disable && enable`. Code
  changes inside `lib/*.js` take effect only after a full shell restart
  (logout / login on Wayland). Settings changes (rules, keybindings,
  toggles) reload immediately.
- Tray-only apps in autostart: if the launched app stays in its own tray
  (e.g. Telegram with `-autostart`), `Shell.App.activate()` cannot pull
  the window out — disable the tray-on-start option in the app itself.

## License

MIT. See [LICENSE](LICENSE).
