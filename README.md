# GNOME Workspace Branch

[![GNOME Shell](https://img.shields.io/badge/GNOME_Shell-50-4A86CF?style=flat-square&logo=gnome&logoColor=white)](https://www.gnome.org/)
[![Wayland](https://img.shields.io/badge/Wayland-ready-success?style=flat-square)](https://wayland.freedesktop.org)
[![Mutter](https://img.shields.io/badge/Mutter-50-2CA5E0?style=flat-square)](https://gitlab.gnome.org/GNOME/mutter)
[![Platform](https://img.shields.io/badge/platform-Linux-blue?style=flat-square&logo=linux&logoColor=white)](https://www.linuxfoundation.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](LICENSE)
[![ESM](https://img.shields.io/badge/GJS-ESM-FFCA28?style=flat-square)](https://gjs.guide/)

A GNOME Shell extension that adds **optional vertical "appendages"** to the
horizontal workspace row. Your main row stays exactly as you configured it —
Auto Move Windows and any other index-based bindings keep working — and on
top of that, every column can grow up and down with extra workspaces.

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
- **Panel indicator** — compact mini-map with a click-menu of all workspaces.
- **Auto-cleanup** — empty appendages disappear on switch / window close.
  Main row workspaces are never touched.
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

1. Never reorders the main row, so indices `1..N` keep their meaning.
2. Appends appendages **at the end** of Mutter's list (`N+1`, `N+2`, …) where
   AMW doesn't look.
3. Removes only appendages by index, never main-row workspaces, so the
   trailing tail you control with us, the rest stays as AMW expects.

You don't need to change a single byte of your AMW configuration.

## Architecture

```
extension.js         # ESM Extension class, enable/disable, signal wiring
prefs.js             # Adw preferences (keybindings + behavior)
lib/
  topology.js        # ColumnTopology — single source of truth (col, layer)
  navigator.js       # switchUp/Down/Left/Right, moveWindow*, removeCurrent
  workspaces.js      # CRUD over Mutter workspaces (append/remove)
  keybindings.js     # Meta keybinding registration
  system-keys.js     # release conflicting native shortcuts on enable
  indicator.js       # panel mini-map + click menu
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
  auto-cleanup.js    # remove empty appendages on switch / window close
schemas/
  org.gnome.shell.extensions.workspace-branch.gschema.xml
metadata.json        # shell-version: ["50"]
Makefile             # install / pack / test
tests/
  topology-test.js   # standalone gjs unit tests for the topology layer
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

## License

MIT. See [LICENSE](LICENSE).
