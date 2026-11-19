/*
 * Tests the Files extension without Files: it is loaded through a GTypeModule
 * as Files does, given fake file items, and its D-Bus calls are answered by
 * a fake GNOME Shell on a private bus. Run tests/test_files_extension.sh.
 */
#include <nautilus-extension.h>
#include <gio/gio.h>

/* A GTypeModule whose types are already linked in. */
typedef struct {GTypeModule parent;} TestModule;
typedef struct {GTypeModuleClass parent_class;} TestModuleClass;
G_DEFINE_TYPE (TestModule, test_module, G_TYPE_TYPE_MODULE)
static gboolean test_module_load (GTypeModule *module) {return TRUE;}
static void test_module_unload (GTypeModule *module) {}
static void test_module_init (TestModule *self) {}
static void test_module_class_init (TestModuleClass *klass)
{
    G_TYPE_MODULE_CLASS (klass)->load = test_module_load;
    G_TYPE_MODULE_CLASS (klass)->unload = test_module_unload;
}

/* A file item with a location and, like Recent items, an activation URI. */
typedef struct {GObject parent; char *uri; char *activation;} FakeFile;
typedef struct {GObjectClass parent_class;} FakeFileClass;
static void fake_file_info_init (NautilusFileInfoInterface *iface);
G_DEFINE_TYPE_WITH_CODE (FakeFile, fake_file, G_TYPE_OBJECT,
                         G_IMPLEMENT_INTERFACE (NAUTILUS_TYPE_FILE_INFO, fake_file_info_init))
static GFile *fake_location (NautilusFileInfo *info) {return g_file_new_for_uri (((FakeFile *) info)->uri);}
static char *fake_activation (NautilusFileInfo *info) {return g_strdup (((FakeFile *) info)->activation);}
static void fake_file_info_init (NautilusFileInfoInterface *iface)
{
    iface->get_location = fake_location;
    iface->get_activation_uri = fake_activation;
}
static void fake_file_finalize (GObject *object)
{
    g_free (((FakeFile *) object)->uri);
    g_free (((FakeFile *) object)->activation);
    G_OBJECT_CLASS (fake_file_parent_class)->finalize (object);
}
static void fake_file_init (FakeFile *self) {}
static void fake_file_class_init (FakeFileClass *klass) {G_OBJECT_CLASS (klass)->finalize = fake_file_finalize;}

static NautilusFileInfo *
fake (const char *uri, const char *activation)
{
    FakeFile *file = g_object_new (fake_file_get_type (), NULL);
    file->uri = g_strdup (uri);
    file->activation = g_strdup (activation);
    return NAUTILUS_FILE_INFO (file);
}

/* The fake GNOME Shell records AskAbout calls. */
static GMainLoop *loop;
static char **received;
static int warnings;

static void
on_method (GDBusConnection *bus, const char *sender, const char *path, const char *iface, const char *method,
           GVariant *parameters, GDBusMethodInvocation *invocation, gpointer data)
{
    g_strfreev (received);
    g_variant_get (parameters, "(^as)", &received);
    g_dbus_method_invocation_return_value (invocation, NULL);
    g_main_loop_quit (loop);
}

static void
on_log (const char *domain, GLogLevelFlags level, const char *message, gpointer data)
{
    if (g_str_has_prefix (message, "GNOME Assistant:")) {
        warnings++;
        g_main_loop_quit (loop);
    }
}

static gboolean on_timeout (gpointer data) {g_error ("Timed out waiting for the extension");}

static const char *expected_label = "Ask GNOME Assistant";

static char *
label_of (GList *items)
{
    g_assert_nonnull (items);
    g_assert_null (items->next);
    char *label = NULL;
    g_object_get (items->data, "label", &label, NULL);
    return label;
}

/* Activate the single menu item and wait for the call or failure it causes. */
static void
activate (GList *items)
{
    g_autofree char *label = label_of (items);
    g_assert_cmpstr (label, ==, expected_label);
    nautilus_menu_item_activate (items->data);
    guint timeout = g_timeout_add_seconds (5, on_timeout, NULL);
    g_main_loop_run (loop);
    g_source_remove (timeout);
    nautilus_menu_item_list_free (items);
}

static void
expect (const char *const *uris)
{
    g_assert_nonnull (received);
    g_assert_true (g_strv_equal ((const char *const *) received, uris));
    g_clear_pointer (&received, g_strfreev);
}

int
main (void)
{
    void nautilus_module_initialize (GTypeModule *module);
    void nautilus_module_list_types (const GType **types, int *count);
    loop = g_main_loop_new (NULL, FALSE);
    g_log_set_handler (NULL, G_LOG_LEVEL_WARNING, on_log, NULL);

    GTypeModule *module = g_object_new (test_module_get_type (), NULL);
    g_type_module_use (module);
    nautilus_module_initialize (module);
    const GType *types;
    int count;
    nautilus_module_list_types (&types, &count);
    g_assert_cmpint (count, ==, 1);
    g_assert_true (g_type_is_a (types[0], NAUTILUS_TYPE_MENU_PROVIDER));
    NautilusMenuProvider *provider = g_object_new (types[0], NULL);

    GDBusConnection *bus = g_bus_get_sync (G_BUS_TYPE_SESSION, NULL, NULL);
    g_autoptr (GDBusNodeInfo) node = g_dbus_node_info_new_for_xml (
        "<node><interface name='org.gnome.Shell.Extensions.GnomeAssistant'>"
        "<method name='AskAbout'><arg type='as' direction='in'/></method></interface></node>", NULL);
    GDBusInterfaceVTable vtable = {on_method, NULL, NULL, {0}};
    guint object = g_dbus_connection_register_object (bus, "/org/gnome/Shell/Extensions/GnomeAssistant",
                                                      node->interfaces[0], &vtable, NULL, NULL, NULL);
    g_bus_own_name_on_connection (bus, "org.gnome.Shell", G_BUS_NAME_OWNER_FLAGS_NONE, NULL, NULL, NULL, NULL);
    while (!g_dbus_connection_flush_sync (bus, NULL, NULL));
    g_main_context_iteration (NULL, FALSE);

    /* Files registers selection and background entries as actions named
     * after the item, side by side: the names must differ, or the folder
     * entry replaces the selection entry. */
    {
        GList *selected = g_list_append (NULL, fake ("file:///home/user/hello.txt", NULL));
        NautilusFileInfo *here = fake ("file:///home/user", NULL);
        GList *selection_items = nautilus_menu_provider_get_file_items (provider, selected);
        GList *folder_items = nautilus_menu_provider_get_background_items (provider, here);
        g_autofree char *selection_name = NULL, *folder_name = NULL;
        g_object_get (selection_items->data, "name", &selection_name, NULL);
        g_object_get (folder_items->data, "name", &folder_name, NULL);
        g_assert_cmpstr (selection_name, !=, folder_name);
        nautilus_menu_item_list_free (selection_items);
        nautilus_menu_item_list_free (folder_items);
        g_list_free_full (selected, g_object_unref);
        g_object_unref (here);
    }

    /* Selected files and folders, including a name that needs escaping. */
    GList *files = g_list_append (NULL, fake ("file:///home/user/notes.txt", NULL));
    files = g_list_append (files, fake ("file:///home/user/My%20Project", NULL));
    activate (nautilus_menu_provider_get_file_items (provider, files));
    expect ((const char *[]) {"file:///home/user/notes.txt", "file:///home/user/My%20Project", NULL});
    g_list_free_full (files, g_object_unref);

    /* Right-clicking a folder's background sends that folder. */
    NautilusFileInfo *folder = fake ("file:///home/user/thesis", NULL);
    activate (nautilus_menu_provider_get_background_items (provider, folder));
    expect ((const char *[]) {"file:///home/user/thesis", NULL});
    g_object_unref (folder);

    /* Recent and Starred items resolve to their real file; Trash is skipped. */
    files = g_list_append (NULL, fake ("recent:///abc123", "file:///home/user/report.pdf"));
    files = g_list_append (files, fake ("trash:///old.txt", NULL));
    activate (nautilus_menu_provider_get_file_items (provider, files));
    expect ((const char *[]) {"file:///home/user/report.pdf", NULL});
    g_list_free_full (files, g_object_unref);

    /* Nothing local: no menu entry at all. */
    files = g_list_append (NULL, fake ("trash:///old.txt", NULL));
    g_assert_null (nautilus_menu_provider_get_file_items (provider, files));
    g_list_free_full (files, g_object_unref);
    NautilusFileInfo *network = fake ("sftp://server/home", NULL);
    g_assert_null (nautilus_menu_provider_get_background_items (provider, network));
    g_object_unref (network);

    /* The menu uses the name chosen in Preferences, normalised like the Shell
     * extension does. The script points GSettings at the repository schema
     * and an in-memory backend, never at the user's settings. */
    g_autoptr (GSettings) settings = g_settings_new ("org.gnome.shell.extensions.gnome-assistant");
    const char *names[][2] = {
        {"Jarvis", "Ask Jarvis"},
        {"   Friday  ", "Ask Friday"},
        {"Assistant with a very long name, cut at forty", "Ask Assistant with a very long name, cut at"},
        {"   ", "Ask GNOME Assistant"},
        {"Été ☕", "Ask Été ☕"},
    };
    for (gsize i = 0; i < G_N_ELEMENTS (names); i++) {
        g_settings_set_string (settings, "assistant-name", names[i][0]);
        files = g_list_append (NULL, fake ("file:///home/user/notes.txt", NULL));
        GList *items = nautilus_menu_provider_get_file_items (provider, files);
        g_autofree char *label = label_of (items);
        g_assert_cmpstr (label, ==, names[i][1]);
        nautilus_menu_item_list_free (items);
        g_list_free_full (files, g_object_unref);
    }
    g_settings_reset (settings, "assistant-name");

    /* GNOME Assistant not running: the user is told, nothing is sent. */
    g_dbus_connection_unregister_object (bus, object);
    files = g_list_append (NULL, fake ("file:///home/user/notes.txt", NULL));
    activate (nautilus_menu_provider_get_file_items (provider, files));
    g_assert_null (received);
    g_assert_cmpint (warnings, ==, 1);
    g_list_free_full (files, g_object_unref);

    g_object_unref (provider);
    g_object_unref (bus);
    g_print ("FILES EXTENSION TESTS PASSED\n");
    return 0;
}
