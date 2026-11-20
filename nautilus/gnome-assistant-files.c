/*
 * "Ask GNOME Assistant" in the Files right-click menu, using the assistant
 * name chosen in GNOME Assistant's Preferences.
 *
 * Selected files and folders, or the folder whose background was clicked,
 * are sent to the GNOME Assistant Shell extension over D-Bus. The extension
 * opens the assistant and adds them: as references for an agent running on
 * this computer, or as streamed attachments for a remote agent.
 */
#include <nautilus-extension.h>
#include <gio/gio.h>

#define SHELL_BUS_NAME "org.gnome.Shell"
#define ASSISTANT_PATH "/org/gnome/Shell/Extensions/GnomeAssistant"
#define ASSISTANT_INTERFACE "org.gnome.Shell.Extensions.GnomeAssistant"
#define SCHEMA_ID "org.gnome.shell.extensions.gnome-assistant"
#define EXTENSION_UUID "gnome-assistant@palpatraz02"
#define DEFAULT_NAME "GNOME Assistant"
#define MAX_NAME_LENGTH 40

/* The GNOME Assistant settings, whose schema ships with the Shell extension
 * rather than system-wide: look for it there, or in the default schema path.
 * Values are shared through dconf, so changes apply on the next right-click. */
static GSettings *
assistant_settings (void)
{
    static GSettings *settings;
    static gboolean searched;
    if (searched)
        return settings;
    searched = TRUE;
    GSettingsSchemaSource *source = g_settings_schema_source_get_default ();
    g_autoptr (GSettingsSchema) schema = source ? g_settings_schema_source_lookup (source, SCHEMA_ID, TRUE) : NULL;
    g_autofree char *user = g_build_filename (g_get_user_data_dir (), "gnome-shell", "extensions", EXTENSION_UUID,
                                              "schemas", NULL);
    const char *directories[] = {user, "/usr/share/gnome-shell/extensions/" EXTENSION_UUID "/schemas"};
    for (gsize i = 0; schema == NULL && i < G_N_ELEMENTS (directories); i++) {
        g_autoptr (GSettingsSchemaSource) local = g_settings_schema_source_new_from_directory (
            directories[i], source, FALSE, NULL);
        if (local != NULL)
            schema = g_settings_schema_source_lookup (local, SCHEMA_ID, FALSE);
    }
    if (schema != NULL && g_settings_schema_has_key (schema, "assistant-name"))
        settings = g_settings_new_full (schema, NULL, NULL);
    return settings;
}

/* Normalised as the Shell extension does: trimmed, at most 40 characters,
 * and the default when empty. */
static char *
assistant_name (void)
{
    GSettings *settings = assistant_settings ();
    g_autofree char *value = settings ? g_settings_get_string (settings, "assistant-name") : NULL;
    if (value == NULL || !g_utf8_validate (value, -1, NULL))
        return g_strdup (DEFAULT_NAME);
    g_strstrip (value);
    glong length = MIN (g_utf8_strlen (value, -1), MAX_NAME_LENGTH);
    g_autofree char *trimmed = g_utf8_substring (value, 0, length);
    g_strstrip (trimmed);
    return *trimmed ? g_steal_pointer (&trimmed) : g_strdup (DEFAULT_NAME);
}

typedef struct {
    GObject parent;
} GnomeAssistantFiles;

typedef struct {
    GObjectClass parent_class;
} GnomeAssistantFilesClass;

static void menu_provider_init (NautilusMenuProviderInterface *iface);

G_DEFINE_DYNAMIC_TYPE_EXTENDED (GnomeAssistantFiles, gnome_assistant_files, G_TYPE_OBJECT, 0,
                                G_IMPLEMENT_INTERFACE_DYNAMIC (NAUTILUS_TYPE_MENU_PROVIDER, menu_provider_init))

/* A file: URI for items on this computer. Recent and Starred items resolve
 * through their activation URI; Trash and network locations have no local
 * path and are skipped. */
static char *
local_uri (NautilusFileInfo *info)
{
    g_autoptr (GFile) location = nautilus_file_info_get_location (info);
    if (location != NULL && g_file_is_native (location))
        return g_file_get_uri (location);

    g_autofree char *activation = nautilus_file_info_get_activation_uri (info);
    if (activation == NULL)
        return NULL;
    g_autoptr (GFile) target = g_file_new_for_uri (activation);
    return g_file_is_native (target) ? g_file_get_uri (target) : NULL;
}

static void
notify_unavailable (const char *reason)
{
    GApplication *app = g_application_get_default ();
    if (app == NULL) {
        g_warning ("GNOME Assistant: %s", reason);
        return;
    }
    g_autofree char *name = assistant_name ();
    g_autofree char *title = g_strdup_printf ("%s is not available", name);
    g_autoptr (GNotification) notification = g_notification_new (title);
    g_notification_set_body (notification,
                             "Enable the GNOME Assistant extension, then try again.");
    g_application_send_notification (app, "gnome-assistant-files", notification);
}

static void
on_ask_reply (GObject *source, GAsyncResult *result, gpointer user_data)
{
    g_autoptr (GError) error = NULL;
    g_autoptr (GVariant) reply = g_dbus_connection_call_finish (G_DBUS_CONNECTION (source), result, &error);
    if (reply == NULL)
        notify_unavailable (error->message);
}

static void
on_bus (GObject *source, GAsyncResult *result, gpointer user_data)
{
    g_auto (GStrv) uris = user_data;
    g_autoptr (GError) error = NULL;
    g_autoptr (GDBusConnection) bus = g_bus_get_finish (result, &error);
    if (bus == NULL) {
        notify_unavailable (error->message);
        return;
    }
    g_dbus_connection_call (bus, SHELL_BUS_NAME, ASSISTANT_PATH, ASSISTANT_INTERFACE, "AskAbout",
                            g_variant_new ("(^as)", uris), NULL, G_DBUS_CALL_FLAGS_NO_AUTO_START,
                            5000, NULL, on_ask_reply, NULL);
}

static void
on_activate (NautilusMenuItem *item, gpointer user_data)
{
    g_bus_get (G_BUS_TYPE_SESSION, NULL, on_bus, g_strdupv (user_data));
}

/* Files builds the selection and background menus together and registers
 * each entry as an action named after the item, in one action group: the
 * two entries need distinct names, or the background one (the current
 * folder) replaces the selection one. */
#define SELECTION_ITEM "GnomeAssistantFiles::ask-selection"
#define FOLDER_ITEM "GnomeAssistantFiles::ask-folder"

static GList *
ask_item (const char *item_name, GPtrArray *uris)
{
    if (uris->len == 0)
        return NULL;
    g_ptr_array_add (uris, NULL);
    g_autofree char *name = assistant_name ();
    g_autofree char *label = g_strdup_printf ("Ask %s", name);
    g_autofree char *tip = g_strdup_printf ("Add to a %s chat", name);
    NautilusMenuItem *item = nautilus_menu_item_new (item_name, label, tip, NULL);
    g_signal_connect_data (item, "activate", G_CALLBACK (on_activate),
                           g_ptr_array_steal (uris, NULL), (GClosureNotify) (void (*) (void)) g_strfreev, 0);
    return g_list_append (NULL, item);
}

static GList *
get_file_items (NautilusMenuProvider *provider, GList *files)
{
    g_autoptr (GPtrArray) uris = g_ptr_array_new_with_free_func (g_free);
    for (GList *file = files; file != NULL; file = file->next) {
        char *uri = local_uri (NAUTILUS_FILE_INFO (file->data));
        if (uri != NULL)
            g_ptr_array_add (uris, uri);
    }
    return ask_item (SELECTION_ITEM, uris);
}

/* Right-clicking a folder's background, with nothing selected. */
static GList *
get_background_items (NautilusMenuProvider *provider, NautilusFileInfo *current_folder)
{
    g_autoptr (GPtrArray) uris = g_ptr_array_new_with_free_func (g_free);
    char *uri = local_uri (current_folder);
    if (uri != NULL)
        g_ptr_array_add (uris, uri);
    return ask_item (FOLDER_ITEM, uris);
}

static void
menu_provider_init (NautilusMenuProviderInterface *iface)
{
    iface->get_file_items = get_file_items;
    iface->get_background_items = get_background_items;
}

static void
gnome_assistant_files_init (GnomeAssistantFiles *self)
{
}

static void
gnome_assistant_files_class_init (GnomeAssistantFilesClass *klass)
{
}

static void
gnome_assistant_files_class_finalize (GnomeAssistantFilesClass *klass)
{
}

static GType types[1];

void
nautilus_module_initialize (GTypeModule *module)
{
    gnome_assistant_files_register_type (module);
    types[0] = gnome_assistant_files_get_type ();
}

void
nautilus_module_shutdown (void)
{
}

void
nautilus_module_list_types (const GType **list, int *count)
{
    *list = types;
    *count = G_N_ELEMENTS (types);
}
