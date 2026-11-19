# Builds the "Ask GNOME Assistant" Files extension. Files only loads compiled
# extensions from its system folder, so installing needs administrator rights:
#   make && sudo make install && nautilus -q
PKG = libnautilus-extension-4
EXTENSIONDIR ?= $(shell pkg-config --variable=extensiondir $(PKG))
CFLAGS ?= -O2 -g
WARNINGS = -Wall -Wextra -Werror -Wno-unused-parameter
LIBRARY = libgnome-assistant-files.so

all: $(LIBRARY)

$(LIBRARY): gnome-assistant-files.c
	$(CC) $(CFLAGS) $(WARNINGS) -shared -fPIC -o $@ $< $(shell pkg-config --cflags --libs $(PKG))

install: $(LIBRARY)
	install -Dm644 $(LIBRARY) $(DESTDIR)$(EXTENSIONDIR)/$(LIBRARY)

uninstall:
	rm -f $(DESTDIR)$(EXTENSIONDIR)/$(LIBRARY)

clean:
	rm -f $(LIBRARY)

.PHONY: all install uninstall clean
