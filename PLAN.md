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

### Фаза 1 — MVP
- [ ] Скаффолд (metadata.json, extension.js ESM, schema, Makefile)
- [ ] Topology + persist в gsettings
- [ ] Команды: switchUp/Down, createAbove(currentCol), createBelow(currentCol), removeCurrent
- [ ] 4 биндинга: up/down/create-up/create-down
- [ ] Подписка на `workspace-added/removed` для синхронизации
- [ ] Тест-сценарий ниже проходит

**Критерий приёмки:** Главный ряд из 4 воркспейсов с привязками AMW. Я на воркспейсе 2, жму `Super+Ctrl+Up` — создаётся отросток сверху, я на нём. `Super+Down` возвращает на 2. `Super+Right` — на 3. Привязки AMW (Firefox→2, Telegram→3) продолжают работать. Перезапуск GNOME Shell — отростки восстанавливаются из gsettings.

### Фаза 2 — Overview integration (приоритет!)
- [ ] Изучить актуальный `js/ui/workspaceThumbnail.js` под GNOME 50 (распаковать gresource)
- [ ] Рендер существующих отростков как thumbnail-ов над/под главным рядом
- [ ] Drop-placeholder сверху и снизу каждой колонки при drag окна
- [ ] `_acceptDrop` создаёт отросток и переносит окно
- [ ] Клик по thumbnail отростка → switch на него
- [ ] Откат monkey-patch при `disable()`

**Критерий приёмки:** В overview видно главный ряд + у воркспейса 2 один отросток сверху (если был создан). Перетаскиваю окно над колонкой 3 → появляется точечка → дроп → создаётся новый воркспейс над колонкой 3, окно в нём, в overview виден новый thumbnail.

### Фаза 3 — UX полировка
- [ ] Move window вверх/вниз с клавиатуры
- [ ] Панельная мини-карта (горизонтальная полоска + точки над/под)
- [ ] Адекватное поведение при ручных манипуляциях с воркспейсами через GNOME
- [ ] Опция «left/right в отростке = соседний отросток той же глубины (вариант B)»

### Фаза 4 — Анимация
- [ ] Slide вверх/вниз поверх стандартного слайда влево/вправо (через WorkspaceAnimationController)
- [ ] (опц.) интеграция / совместимость с Desktop Cube для главного ряда

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

1. Дефолт left/right в отростке: снапаться на главный ряд (A) или ходить по соседним отросткам (B)? — **предлагаю A**.
2. Создание отростка автоматическое (`Super+Up` на пустом → создать) или строго отдельным `Super+Ctrl+Up`? — **строго отдельный**, чтобы не было сюрпризов.
3. Лимит глубины отростков? — мягкий (warning после, скажем, 5 уровней), без жёсткого.
4. Хранить topology per-monitor или глобально? — **глобально** для MVP.
5. Восстановление после reboot: воркспейсы Mutter не сохраняются между сессиями. На следующий вход нужно либо пересоздавать отростки из gsettings (тогда пользователь увидит лишние пустые воркспейсы), либо забывать их. — **предлагаю пересоздавать**, с опцией «забывать пустые».
6. В overview — лимит видимых отростков на колонку (скролл/clamp)? Предлагаю clamp на 3 видимых сверху и снизу, остальные — через keyboard.
