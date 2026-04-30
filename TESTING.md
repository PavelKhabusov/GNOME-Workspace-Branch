# Testing checklist

Сценарии для ручной проверки. Запускать в `make nested` (Wayland), либо после
`make install` + `Alt+F2 r` (X11) / logout-login (Wayland).

Перед каждым прогоном:
- `gnome-extensions enable workspace-branch@pavel.local`
- проверить логи: `journalctl --user -f /usr/bin/gnome-shell | grep workspace-branch`

## Phase 1 — acceptance (PLAN.md §4)

### S1. Базовая навигация
1. Главный ряд из 4 воркспейсов (`gsettings set org.gnome.desktop.wm.preferences num-workspaces 4`).
2. На WS2: `Super+Ctrl+Up` → создаётся отросток сверху, активируется.
3. `Super+Down` → возврат на WS2.
4. `Super+Right` → WS3.
5. `Super+Up` на WS3 → ничего (нет отростка).

**Pass:** на каждом шаге активный воркспейс совпадает с ожидаемым.

### S2. Совместимость с Auto Move Windows
1. `gsettings set org.gnome.shell.extensions.auto-move-windows application-list "['firefox.desktop:2', 'org.telegram.desktop.desktop:3']"`.
2. Создать 2 отростка над WS2, 1 под WS3.
3. Открыть Firefox → должен попасть на WS2 (не на отросток).
4. Открыть Telegram → должен попасть на WS3.

**Pass:** AMW по-прежнему уважает индексы 1..N главного ряда.

### S3. Persist через gsettings
1. Создать отростки: 1 над WS1, 2 над WS2, 1 под WS2.
2. Прочитать: `gsettings get org.gnome.shell.extensions.workspace-branch appendages`
3. Должно быть `'[{"col":1,"dir":"up"},{"col":2,"dir":"up"},{"col":2,"dir":"up"},{"col":2,"dir":"down"}]'`.
4. `gsettings get org.gnome.shell.extensions.workspace-branch main-row-size` → `4`.

**Pass:** state сохраняется корректно, в порядке создания.

### S4. Перезапуск shell (X11)
1. Setup из S3.
2. `Alt+F2 r Enter`.
3. После рестарта: тот же набор отростков, навигация работает.

**Pass:** топология восстанавливается из gsettings.

### S5. Перезапуск сессии (Wayland) / dozаливка отростков
1. Setup из S3, проверить `wmctrl -d | wc -l` → 8 (4 main + 4 appendages).
2. Logout + login.
3. После входа должно быть снова 8 воркспейсов, навигация работает.

**Pass:** `_restoreAppendages()` дозалил недостающие.

### S6. Move window
1. Открыть приложение на WS2, создать отросток над ним.
2. Вернуться на WS2, окно туда же (`Super+Shift+Down` если из отростка).
3. С WS2: `Super+Shift+Up` → окно уехало на отросток, фокус там же.

**Pass:** окно меняет воркспейс синхронно с переключением.

### S7. Remove current
1. Setup: 2 отростка над WS2, на верхнем (layer=-2) открыто 2 окна.
2. Активировать верхний отросток, `Super+Ctrl+Shift+BackSpace`.
3. Окна должны переехать на WS2 (main колонки), не на промежуточный отросток.
4. После удаления: `appendages` в gsettings ужался на 1, индексы остальных не сбились.

**Pass:** окна попадают на main, топология консистентна.

### S8. Внешние манипуляции с воркспейсами
1. Setup из S3.
2. `gsettings set org.gnome.desktop.wm.preferences num-workspaces 5` (расширили main снаружи).
3. Должно быть: mainRowSize=5, appendages не потерялись.
4. `gsettings set ... num-workspaces 4` обратно — отростки могут быть сдвинуты, но не падает.

**Pass:** extension не падает, навигация продолжает работать (хотя бы по main-ряду).

### S9. Disable очистка
1. Setup из S3.
2. `gnome-extensions disable workspace-branch@pavel.local`.
3. Биндинги не работают (`Super+Up` снова unmaximize).
4. `dynamic-workspaces` восстановлен в исходное значение (запомнить до enable).

**Pass:** ничего не висит, хоткеи возвращены системе.

## Negative / quirky

### N1. Создание из самого отростка
- На отростке (col=2, layer=-1): `Super+Ctrl+Up` → должен создаться layer=-2.
- `Super+Ctrl+Down` из layer=-1 → создаётся layer=+1 (под main колонки 2).

### N2. Переход в несуществующий слой
- `Super+Down` с main без отростков снизу → ничего, не падает.
- `Super+Up` на самом верхнем отростке → ничего.

### N3. Move window в пустоту
- `Super+Shift+Up` на main без отростка сверху → окно остаётся, не падает.

### N4. Удаление воркспейса извне
- Setup: 2 отростка над WS2.
- `wmctrl -s 5; wmctrl -d` (или dconf hack) — удалить произвольный.
- Topology должна откорректироваться (либо в фолбэк, либо точечно).

## Что не покрыто

- Overview / DnD — Фаза 2.
- Move window между несоседними колонками — нет такого действия.
- Конкурирующие расширения, которые тоже трогают workspace_manager.
- Multi-monitor (per-monitor topology — открытый вопрос §7.4, отложено).
