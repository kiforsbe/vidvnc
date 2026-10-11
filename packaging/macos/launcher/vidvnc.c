// vidvnc: the command-line server's launcher on macOS, in the app (Contents/Helpers/vidvnc)
// and at the top of the command-line ZIP. It runs the bundled Node.js on the bundled server
// with the package's runtime manifest, passing its arguments through, so `vidvnc` uses the
// same settings and logs as the app (spec Q10). It works through a symbolic link, such as
// the one the app's Install Command-Line Tool makes, because it starts from its own real
// path. build.mjs compiles it with the package's layout, relative to the launcher's folder:
// VIDVNC_NODE, VIDVNC_SERVER and VIDVNC_MANIFEST.
#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#if !defined(VIDVNC_NODE) || !defined(VIDVNC_SERVER) || !defined(VIDVNC_MANIFEST)
#error "build.mjs defines VIDVNC_NODE, VIDVNC_SERVER and VIDVNC_MANIFEST"
#endif

extern char **environ;

static int fail(const char *what) {
    fprintf(stderr, "vidvnc: %s: %s. Reinstall VidVNC.\n", what, strerror(errno));
    return 1;
}

// `folder` + "/" + `relative`, resolved, into `out`.
static int locate(const char *folder, const char *relative, char out[PATH_MAX]) {
    char joined[PATH_MAX];
    if (snprintf(joined, sizeof joined, "%s/%s", folder, relative) >= (int)sizeof joined) {
        errno = ENAMETOOLONG;
        return -1;
    }
    return realpath(joined, out) ? 0 : -1;
}

int main(int argc, char **argv) {
    char self[PATH_MAX], real[PATH_MAX];
    uint32_t size = sizeof self;
    if (_NSGetExecutablePath(self, &size) != 0 || !realpath(self, real))
        return fail("cannot find its own location");
    char *slash = strrchr(real, '/');
    if (!slash)
        return fail("cannot find its own folder");
    *slash = '\0';

    char node[PATH_MAX], server[PATH_MAX], manifest[PATH_MAX];
    if (locate(real, VIDVNC_NODE, node) != 0)
        return fail("cannot find the bundled Node.js");
    if (locate(real, VIDVNC_SERVER, server) != 0)
        return fail("cannot find the server");
    if (locate(real, VIDVNC_MANIFEST, manifest) != 0)
        return fail("cannot find the runtime manifest");

    // Only the package's own runtime: no inherited Node.js options, preloads or paths.
    for (;;) {
        char **entry = environ;
        while (*entry && strncmp(*entry, "NODE_", 5) != 0)
            entry++;
        if (!*entry)
            break;
        char name[256];
        const size_t length = strcspn(*entry, "=");
        if (length >= sizeof name) {
            errno = EINVAL;
            return fail("cannot clear the environment");
        }
        memcpy(name, *entry, length);
        name[length] = '\0';
        if (unsetenv(name) != 0)
            return fail("cannot clear the environment");
    }
    if (setenv("VIDVNC_RUNTIME_MANIFEST", manifest, 1) != 0)
        return fail("cannot set the runtime manifest");

    char **arguments = calloc((size_t)argc + 2, sizeof *arguments);
    if (!arguments)
        return fail("out of memory");
    arguments[0] = node;
    arguments[1] = server;
    for (int index = 1; index < argc; index++)
        arguments[index + 1] = argv[index];
    execv(node, arguments);
    return fail("cannot start the bundled Node.js");
}
