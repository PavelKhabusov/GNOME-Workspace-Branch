# gnome-workspace-branch

GNOME Shell расширение для **опциональных вертикальных «отростков»** к существующему горизонтальному ряду воркспейсов. Главный ряд остаётся ровно таким, какой пользователь настроил — Auto Move Windows и любые другие привязки по индексам не ломаются. Сверху и снизу любой колонки можно опционально нарастить дополнительные воркспейсы и навигировать между ними клавишами вверх/вниз.

Целевая платформа: **GNOME Shell 50** (Mutter 50, GJS ESM).

---

## 1. Ментальная модель

```
                  [up_2]
                    |
      [up_1]      [up_1]
        |           |
  WS0 -- WS1 -- WS2 -- WS3 -- WS4   <-- главный ряд (без изменений)
                    |
                  [dn_1]
```

- **Главный ряд** = текущие GNOME-воркспейсы, их индексы и количество. Мы их **не трогаем**.
- **Отростки** — это дополнительные воркспейсы, привязанные к конкретной колонке главного ряда: `(col=2, dir=up, depth=1)`. Создаются по требованию пользователя (`Super+Shift+Up` на пустом или вручную).
- Логически воркспейс в системе всё ещё один линейный список Mutter, но мы знаем, какие индексы — «главный ряд», а какие — отростки конкретных колонок.
- В пустых колонках сверху/снизу клавиша вверх/вниз ничего не делает (или предлагает создать).

---

## 2. Совместимость с Auto Move Windows

Auto Move Windows читает `org.gnome.shell.extensions.auto-move-windows application-list` — пары `app.desktop:N`, где N — 1-based линейный индекс воркспейса. У нас:

1. Главный ряд **никогда** не реорганизуется → индексы 1..N в AMW работают как раньше.
2. Отростки создаются **в конец** списка Mutter (индексы N+1, N+2, ...). AMW их не использует, мы — используем.
3. При удалении отростка удаляем только **последний** по индексу, либо после любого удаления рескан + ремап (но не трогаем индексы ≤ N).

Итого: пользователь не должен ни на байт менять свою конфигурацию AMW.

---

## 3. Архитектура

```
extension.js          # ESM Extension class, enable/disable
prefs.js              # Adw настройки (биндинги, поведение, persist)
lib/
  topology.js         # ColumnTopology: колонка -> {up:[wsIdx,...], down:[wsIdx,...]}
                      #   single source of truth для того, что где висит
  navigator.js        # switchUp/Down/Left/Right, moveWindowUp/Down/...
                      #   resolve current position -> (col, layer)
                      #   для главного ряда layer = 0
  workspaces.js       # CRUD отростков: createAbove(col), createBelow(col),
                      #   removeAt(col, layer), сериализация в gsettings
  keybindings.js      # регистрация Meta keybindings + handlers
  indicator.js        # (фаза 2) панельная мини-карта — главный ряд + отростки
schemas/
  org.gnome.shell.extensions.workspace-branch.gschema.xml
metadata.json         # shell-version: ["50"]
```

### 3.1 Topology (центральный модуль)

Состояние:
```
mainRowSize: int                           // = workspace_manager.n_workspaces в момент enable
columns: Map<col, {up: int[], down: int[]}> // wsIdx-ы отростков, по слоям
                                            // up[0] = первый сверху, up[1] = второй сверху
```

Хранилище: `gsettings` ключ `topology` (string-JSON). Загружаем при `enable()`, валидируем относительно реального состояния Mutter (удалили снаружи — выбрасываем из map).

API:
```
positionOf(wsIdx): {col, layer}           // layer < 0 = up, > 0 = down, 0 = main
indexAt(col, layer): wsIdx | null
neighbor(pos, dir): pos | null            // правила навигации в §3.3
ensureAbove(col): wsIdx                   // создать ещё один слой сверху
ensureBelow(col): wsIdx
prune(wsIdx): void                        // вызывать на workspace-removed
```

### 3.2 Создание/удаление отростков

Создание:
1. `meta_workspace_manager_append_new_workspace()` (или `n_workspaces += 1` через gsettings, в зависимости от dynamic flag).
2. Запомнить полученный индекс в `topology.columns[col].up.push(idx)`.
3. Сохранить в gsettings.

Удаление:
1. Найти максимальный индекс среди всех отростков; если удаляем не его — переехать активным окнам нечего, просто удаляем рабочий процесс через `remove_workspace(ws, time)`.
2. Mutter перенумерует всё, что было после удалённого. Подписаны на `workspace-removed` → `topology.prune()` сдвигает все запомненные индексы > удалённого на -1.
3. **Главный ряд не меняется**, потому что отростки всегда имеют индекс > mainRowSize-1.

Подвох: если пользователь добавляет/удаляет воркспейсы напрямую (через GNOME), мы должны это засечь. Слушаем `workspace-added`/`workspace-removed` и:
- если изменился размер главного ряда — обновляем mainRowSize, чистим/сдвигаем topology.
- если кто-то удалил воркспейс из середины — пересобираем индексы.

### 3.3 Правила навигации

Текущая позиция вычисляется из `workspace_manager.get_active_workspace_index()` через `topology.positionOf()`:

| Откуда | Действие | Куда |
|---|---|---|
| main (col, 0) | left/right | main (col∓1, 0) — стандартное поведение |
| main (col, 0) | up | если есть `columns[col].up[0]` → туда; иначе ничего (или offer-create) |
| main (col, 0) | down | аналогично down[0] |
| up (col, layer<0) | up | если `up[|layer|]` есть → туда; иначе ничего |
| up (col, layer<0) | down | если layer == -1 → main (col, 0); иначе up[|layer|-2] |
| up (col, layer<0) | left/right | **снапаемся обратно на main (col±1, 0)** (вариант A, простой) ИЛИ переходим в up[layer] соседней колонки если он есть (вариант B, «настоящая 2D»). Делаем настройку, default = A. |

Вариант A проще и интуитивнее: «сверху висит блокнот для воркспейса 2; левый край блокнота — это воркспейс 1». Пользователь не теряется.

### 3.4 Move window

Те же правила, но через `window.change_workspace_by_index(target, append=false)`. Если целевой колонки/слоя ещё нет — действие тихо игнорируем (или, по настройке, создаём отросток на лету при `Super+Shift+Up`).

### 3.5 Overview: drag-and-drop создание отростков

В режиме Activities (overview) GNOME сейчас показывает горизонтальную ленту thumbnails главного ряда. В конце ленты при перетаскивании окна появляется placeholder («точечка» / `+`) — дроп туда создаёт новый воркспейс. Нам нужно то же самое, но **сверху и снизу каждой колонки**.

Поведение:
- Над thumbnail-ом колонки и под ним появляется зона-placeholder при начале drag (window или app icon).
- Если в колонке уже есть отростки — они отображаются стопкой над/под thumbnail-ом главного ряда, а placeholder — на самом краю стопки.
- Дроп в placeholder → `topology.ensureAbove(col)` / `ensureBelow(col)` → перенос окна в новый воркспейс.
- Дроп на существующий thumbnail отростка → перенос окна туда без создания.
- Клик по thumbnail отростка → переключение на него (как и для главного ряда).

Технически:
- `ThumbnailsBox` в `ui/workspaceThumbnail.js` отвечает за ленту. Это `St.Widget` с кастомным allocate.
- `WorkspaceThumbnail` — отдельный thumbnail с `_acceptDrop()`.
- `_dropPlaceholder` — та самая «точечка» в конце ленты, показывается через `_DragMonitor`.

Подход: **обернуть/заменить ThumbnailsBox**. Два варианта:
- **A. Monkey-patch.** Сохраняем оригинальный allocate, после него для каждого thumbnail главного ряда создаём дополнительные `WorkspaceThumbnail`-инстансы для отростков и располагаем их над/под, плюс инжектим placeholder-ы. Меньше кода, но хрупко: любое изменение в allocate в новой минорной версии GNOME — и ломаемся.
- **B. Своя реализация ThumbnailsBox.** Скопировать логику thumbnail-а целиком, заменить ленту нашим виджетом, который умеет 2D. Больше кода, зато контроль и предсказуемость.

**Решение для MVP-overview: вариант A.** Если ломается на minor-апдейте — переходим к B.

Точки внедрения (по [shell-source](https://gitlab.gnome.org/GNOME/gnome-shell/-/tree/gnome-50/js/ui)):
- `Main.overview._overview._controls._thumbnailsBox` — берём ссылку.
- Подменяем `vfunc_allocate` (или `_allocate` приватный) через прототип, оборачиваем оригинал.
- Инжектим свой `_DragMonitor` для отслеживания drag-событий поверх вертикальных placeholder-ов.
- Хук на `_acceptDrop` отростка-placeholder → создание + перенос окна.

Подвох: приватные имена (`_thumbnailsBox`, `_dropPlaceholder`) — нестабильный API. Нужен `try/catch` фолбэк и version-check на старте.

### 3.6 Keybindings (дефолт)

| Действие | Шорткат |
|---|---|
| Switch left/right | `Super+Left/Right` (как сейчас в GNOME) — **не трогаем системные**, только дополняем |
| Switch up/down | `Super+Up/Down` (наши) |
| Move window up/down | `Super+Shift+Up/Down` |
| Create+switch up/down | `Super+Ctrl+Up/Down` |
| Remove current vertical | `Super+Ctrl+Shift+Backspace` |

Системные `Super+Up` сейчас = «развернуть окно». Перед регистрацией показываем в prefs warning и предлагаем переназначить. Откат при disable.

---

## 4. Этапы

### Фаза 1 — MVP ✅
- [x] Скаффолд (metadata.json, extension.js ESM, schema, Makefile)
- [x] Topology + persist в gsettings
- [x] Команды: switchUp/Down, createAbove/Below, removeCurrent, extendRowRight, moveWindow*
- [x] Биндинги: up/down/left/right + create-up/create-down + extend-row-right + move-window-* + remove-current
- [x] Подписка на `workspace-added/removed`
- [x] Восстановление отростков после Wayland-релогина

### Фаза 2 — Overview integration ✅
- [x] `GridThumbnailsBox` — субкласс `ThumbnailsBox`, 2D-раскладка + DnD-зоны над/под колонкой и в конце ряда (extend main row).
- [x] `GridWorkspacesView` — 2D в overview с вертикальными колонками.
- [x] `OverviewPatch` свапает `_thumbnailsBox` через subclass, корректный teardown в `disable()`.

### Фаза 3 — UX полировка ✅
- [x] Move window клавишами (`Super+Shift+Up/Down/Left/Right`).
- [x] Standalone панельная мини-карта (`Indicator`) — fallback.
- [x] Branched-indicator: подмена нативного `WorkspaceIndicators` в `ActivitiesButton`. Натив. WorkspaceDot для main, мини-stripe-pill'ы (приклеены к видимому краю pill'а) для отростков. Читает scaleX/scaleY дота, переезжает за expansion-анимацией.
- [x] Variant A (left/right в отростке снапается на main соседней колонки) — реализовано в `Topology.neighbor`. Variant B остаётся опциональным расширением.
- [x] Auto-cleanup отростков и main-row: `lib/auto-cleanup.js`. Цепная очистка по колонке, переиндексация appendages при `removeMainColumn(col)`.
- [x] Drum-rotation mode (settings `drum-rotation`, default off): `Super+Up/Down` физически переставляет ws через `reorder_workspace`, активный остаётся в main-row.

### Фаза 4 — Анимация ✅ (частично)
- [x] Vertical slide через `VerticalMonitorGroup` + патч `animateSwitch` (горизонтальный slide пропускается для main↔отросток).
- [x] 3-finger vertical swipe + Super+scroll → switchUp/Down (own `SwipeTracker`).
- [x] 4-finger ladder вверх → overview → app grid; вниз — обратно.
- [ ] (опц.) интеграция с Desktop Cube для главного ряда — отложено.

### Фаза 5 — Window routing & autostart ✅
- [x] `lib/window-rules.js` — engine, слушает `display::window-created`, матчит по AND из {`desktop_id` (через Shell.WindowTracker), `wm_class`, `app_id`, `title` regex, `pid_comm` из /proc/PID/comm}.
- [x] Auto-extend main row (`workspace_manager.append_new_workspace` + `reorder_workspace` — потому что `Main.wm.insertWorkspace` no-op в static-режиме, который мы форсим).
- [x] Auto-create отростков для слоёв ±N (loop с safety=32).
- [x] `stack: true` — каждое следующее окно того же `desktop_id` едет глубже на одну ступеньку.
- [x] `lib/autostart.js` — per-rule `autostart: true`. Один раз за сессию (маркер в `$XDG_RUNTIME_DIR/.../launched-this-session`).
  - Если у app уже есть видимое окно (skip_taskbar=false) — пропускаем.
  - STOPPED → `Shell.App.activate()` (умеет в D-Bus и в Exec).
  - RUNNING без окна (Telegram-tray) → activate.
  - Если activate ничего не сделал и state остался STOPPED — fallback на `Gio.Subprocess.new(argv)` с очищенными `%fFuU` placeholders.
- [x] Prefs: визуальный редактор правил (Adw.AlertDialog с формой, Adw.SwitchRow для stack, Gtk.ToggleButton для autostart inline в строке).
- [x] App picker через `Gtk.AppChooserDialog` (то же, что использует AMW).
- [x] Surgical add/edit/delete в ListBox (без full refresh — спиннеры не моргают, скролл не скачет).
- [x] Защита от дублей (`set_response_sensitive(OK, !blocked)`).
- [x] Layout preview: 2D-сетка ячеек `(col, layer)` с иконками правил, DnD для retarget'а правила в другую ячейку. Учитывает `target.col` правил, не только `mainRowSize`.

### Фаза 6 — Profiles (отложено) ⏸
Изначально планировались набор профилей (Work / Gaming) с собственным window-rules + autostart-командами и переключателем в панели. Код есть в `lib/profiles.js` и `lib/profile-switcher.js`, схема ключи `profiles` + `active-profile` сохранены, но UI убран и инсталляция профилей отключена в `extension.js`. Плановый ребут после стабилизации per-rule autostart.

---

## 5. Риски

1. **Внешние изменения числа воркспейсов.** Другое расширение/`gsettings` может добавить/удалить — должны переживать корректно. Решение: всегда пересобирать topology по `workspace-added/removed`, валидировать индексы.
2. **Dynamic workspaces.** Если включено — Mutter сам добавляет/удаляет последний пустой. Это будет конфликтовать с нашими отростками. Решение: при enable форсим `dynamic-workspaces = false`, при disable возвращаем. В prefs — чекбокс с предупреждением.
3. **AMW «сжирает» отросток.** Если пользователь привяжет приложение к индексу > mainRowSize в AMW — оно попадёт в отросток. Это его право, но в README предупредить.
4. **Перезапуск GNOME Shell под X11.** Все индексы воркспейсов сохраняются (в отличие от свежего входа). Persist через gsettings достаточен.
5. **Шорткат `Super+Up` = unmaximize.** Перебивка системного — потенциально раздражающая. Дать возможность выбрать любой шорткат в prefs.
6. **Overview monkey-patch хрупкий.** `ThumbnailsBox` использует приватные методы, которые могут поменяться в minor-версиях GNOME. Защита: жёсткая привязка к `shell-version: ["50"]`, version-check + try/catch фолбэк (если patch не лёг — расширение работает без overview-DnD, только клавиатура).
7. **Layout overview сжимается.** Если отростков много, thumbnails главного ряда ужмутся по вертикали. Нужно ограничить размер вертикальной стопки в overview (скролл? max 3 видимых?).

---

## 6. Сборка и установка

```bash
make install      # копирует в ~/.local/share/gnome-shell/extensions/<uuid>
gnome-extensions enable workspace-branch@pavel.local
# логи:
journalctl -f -o cat /usr/bin/gnome-shell
# nested тест (Wayland):
dbus-run-session -- gnome-shell --nested --wayland
```

UUID: `workspace-branch@pavel.local` (поменять на github-домен перед публикацией в EGO).

---

## 7. Открытые вопросы

1. Дефолт left/right в отростке: снапаться на главный ряд (A) или ходить по соседним отросткам (B)? — **A** реализован, B остаётся опциональным.
2. Создание отростка автоматическое (`Super+Up` на пустом → создать) или строго отдельным `Super+Ctrl+Up`? — **строго отдельный**. Дополнительно: `Super+Shift+Up/Down` создаёт отросток на лету при `move-window`, если в направлении нет слоя.
3. Лимит глубины отростков? — `MAX_LAYERS = 2` для рендера в branched-indicator (overflow guard), сама топология без жёстких ограничений.
4. Хранить topology per-monitor или глобально? — **глобально**.
5. Восстановление после reboot: ✅ пересоздаём в `_restoreAppendages()`, опция `forget-empty-on-disable` для забывания.
6. В overview — лимит видимых отростков на колонку (скролл/clamp)? — пока без скролла, отображаются все.
7. Drum-mode: автосоздаваемая ws при rotation — пока нет, drum работает только если есть существующий слой `+1` в направлении. Можно добавить «авто-create отростка при первом drum-rotate».
8. Layout preview: добавить визуализацию того, какие именно окна сейчас лежат где (живые скриншоты), а не только иконки правил? Пока — только rules.

## 8. Заметки по релизу

- GJS кэширует ES-модули между `gnome-extensions disable && enable`. Изменения в `lib/*.js` подхватываются только после полного рестарта shell (logout/login на Wayland). Settings-изменения подхватываются на лету.
- В static-режиме (`mutter dynamic-workspaces=false`, который мы форсим в `enable()`) `Main.wm.insertWorkspace` no-op — используем `workspace_manager.append_new_workspace` + `reorder_workspace` напрямую.
- Для D-Bus-activatable приложений (Telegram) `Gio.DesktopAppInfo.launch` иногда возвращает success без фактического запуска. `Shell.App.activate()` надёжнее, плюс fallback на Subprocess.
- Tray-only режим (Telegram `-autostart`): activate не вытаскивает окно, нужно отключить в самом приложении.
