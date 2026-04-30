UUID ?= workspace-branch@pavel.local
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_SRC := schemas/org.gnome.shell.extensions.workspace-branch.gschema.xml
SCHEMA_OUT := schemas/gschemas.compiled

JS_SOURCES := extension.js prefs.js
LIB_SOURCES := $(wildcard lib/*.js)

.PHONY: all install uninstall compile-schemas pack clean nested test

all: compile-schemas

test:
	gjs -m tests/topology-test.js

compile-schemas: $(SCHEMA_OUT)

$(SCHEMA_OUT): $(SCHEMA_SRC)
	glib-compile-schemas schemas/

install: compile-schemas
	mkdir -p $(INSTALL_DIR)/lib $(INSTALL_DIR)/schemas
	install -m 644 metadata.json $(JS_SOURCES) $(INSTALL_DIR)/
	install -m 644 $(LIB_SOURCES) $(INSTALL_DIR)/lib/
	install -m 644 $(SCHEMA_SRC) $(SCHEMA_OUT) $(INSTALL_DIR)/schemas/
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Enable: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(INSTALL_DIR)

pack: compile-schemas
	rm -f $(UUID).zip
	zip -r $(UUID).zip metadata.json $(JS_SOURCES) lib schemas

nested:
	dbus-run-session -- gnome-shell --nested --wayland

clean:
	rm -f $(SCHEMA_OUT) $(UUID).zip
