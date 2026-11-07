#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <json-c/json.h>
#include <limits.h>
#include <poll.h>
#include <pwd.h>
#include <grp.h>
#include <systemd/sd-bus.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/signalfd.h>
#include <sys/timerfd.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>

/* One independent runner per call, in the same owner identity and resource scope.
 * Files remain the restart protocol; no app pipe or long-lived launcher owns the result. */
static char *job_path;
static int output = -1;
static char scope_failure[1024];
static int64_t millis(void) {
    struct timespec t;
    clock_gettime(CLOCK_REALTIME, &t);
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static char *suffix(const char *end) {
    char *path;
    if (asprintf(&path, "%s%s", job_path, end) < 0) exit(127);
    return path;
}
static void publish(const char *end, struct json_object *value) {
    char *path = suffix(end), *temporary;
    if (asprintf(&temporary, "%s.tmp", path) < 0) exit(127);
    int fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    const char *text = json_object_to_json_string_ext(value, JSON_C_TO_STRING_PLAIN);
    size_t left = strlen(text);
    if (fd < 0) { perror("foreground_publish"); exit(127); }
    while (left) {
        ssize_t written = write(fd, text, left);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) { perror("foreground_publish"); exit(127); }
        text += written; left -= written;
    }
    if (close(fd) || rename(temporary, path)) { perror("foreground_publish"); exit(127); }
    free(path); free(temporary);
}
static void finish(int code, int sig, const char *termination) {
    struct json_object *result = json_object_new_object();
    json_object_object_add(result, "exitCode", json_object_new_int(code));
    char name[32];
    if (sig) {
        const char *abbreviation = sigabbrev_np(sig);
        if (abbreviation) snprintf(name, sizeof(name), "SIG%s", abbreviation);
        else if (sig == SIGRTMIN) snprintf(name, sizeof(name), "SIGRTMIN");
        else if (sig > SIGRTMIN) snprintf(name, sizeof(name), "SIGRTMIN+%d", sig - SIGRTMIN);
        else snprintf(name, sizeof(name), "SIG%d", sig);
    }
    json_object_object_add(result, "signal", sig ? json_object_new_string(name) : NULL);
    json_object_object_add(result, "termination", json_object_new_string(termination));
    publish(".result", result);
    json_object_put(result);
}
static void failure(const char *message) {
    if (output >= 0) dprintf(output, "\nforeground_spawn_failed: %s\n", message);
    else fprintf(stderr, "foreground_spawn_failed: %s\n", message);
    finish(127, 0, "exit");
    exit(0);
}
static const char *string_field(struct json_object *object, const char *name) {
    struct json_object *value;
    if (!json_object_object_get_ex(object, name, &value) || !json_object_is_type(value, json_type_string)) failure("invalid job string");
    const char *text = json_object_get_string(value);
    if ((size_t)json_object_get_string_len(value) != strlen(text)) failure("job string contains null bytes");
    return text;
}
static const char *cancellation(void) {
    char *path = suffix(".cancel"), text[8] = {0};
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    free(path);
    if (fd < 0) { if (errno != ENOENT) failure(strerror(errno)); return NULL; }
    ssize_t n = read(fd, text, sizeof(text));
    close(fd);
    return n == 7 && !memcmp(text, "timeout", 7) ? "timeout" : "cancelled";
}
static void arm(int fd, double seconds) {
    if (seconds < .001) seconds = .001;
    struct itimerspec timer = {0};
    timer.it_value.tv_sec = (time_t)seconds;
    timer.it_value.tv_nsec = (long)((seconds - timer.it_value.tv_sec) * 1000000000);
    if (timerfd_settime(fd, 0, &timer, NULL)) failure(strerror(errno));
}
/* Enter the same per-call transient scope directly, without systemd-run, setpriv
 * and a shell wrapper. This mode is called only by the root app. Scope identity
 * and properties arrive as app-owned arguments, never from the owner-writable job. */
struct scope_wait { const char *unit; int done; int failed; };
static int scope_done(sd_bus_message *message, void *userdata, sd_bus_error *error) {
    (void)error;
    struct scope_wait *wait = userdata;
    uint32_t id; const char *path, *unit, *result;
    int r = sd_bus_message_read(message, "uoss", &id, &path, &unit, &result);
    if (r < 0) return r;
    if (!strcmp(unit, wait->unit)) { wait->done = 1; wait->failed = strcmp(result, "done") != 0; }
    return 0;
}
static int enter_scope(const char *argument) {
    sd_bus *bus = NULL;
    sd_bus_message *message = NULL, *reply = NULL;
    sd_bus_slot *slot = NULL;
    sd_bus_error error = SD_BUS_ERROR_NULL;
    struct json_object *request = json_tokener_parse(argument), *properties, *uid, *gid, *oom;
    if (!request || geteuid() != 0 || !json_object_object_get_ex(request, "properties", &properties) ||
        !json_object_object_get_ex(request, "uid", &uid) || !json_object_object_get_ex(request, "gid", &gid) ||
        !json_object_object_get_ex(request, "oomScore", &oom)) { fprintf(stderr, "foreground_scope_failed: invalid root scope request\n"); return -2; }
    struct json_object *unit_value;
    if (!json_object_object_get_ex(request, "unit", &unit_value)) { json_object_put(request); return -2; }
    struct scope_wait wait = { .unit = json_object_get_string(unit_value) };
    const char *stage = "connect";
    int r, scope_status = 0;
#define BUS(expression) do { stage = #expression; r = (expression); if (r < 0) goto failed; } while (0)
    /* The root runner can talk to PID 1 directly. Do not put every shell launch
     * through the shared system bus daemon or its authentication/call queues. */
    BUS(sd_bus_new(&bus));
    BUS(sd_bus_set_address(bus, "unix:path=/run/systemd/private"));
    BUS(sd_bus_start(bus));
    BUS(sd_bus_match_signal(bus, &slot, NULL, "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "JobRemoved", scope_done, &wait));
    BUS(sd_bus_call_method(bus, "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "Subscribe", &error, NULL, ""));
    BUS(sd_bus_message_new_method_call(bus, &message, "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "StartTransientUnit"));
    BUS(sd_bus_message_append(message, "ss", wait.unit, "fail"));
    BUS(sd_bus_message_open_container(message, 'a', "(sv)"));
    for (size_t i = 0; i < json_object_array_length(properties); i++) {
        struct json_object *property = json_object_array_get_idx(properties, i);
        const char *name = json_object_get_string(json_object_array_get_idx(property, 0));
        const char *type = json_object_get_string(json_object_array_get_idx(property, 1));
        struct json_object *value = json_object_array_get_idx(property, 2);
        if (!name || !type) { r = -EINVAL; goto failed; }
        BUS(sd_bus_message_open_container(message, 'r', "sv"));
        BUS(sd_bus_message_append(message, "s", name));
        BUS(sd_bus_message_open_container(message, 'v', type));
        if (!strcmp(type, "s")) { BUS(sd_bus_message_append(message, "s", json_object_get_string(value))); }
        else if (!strcmp(type, "t")) { BUS(sd_bus_message_append(message, "t", json_object_get_uint64(value))); }
        else { r = -EINVAL; goto failed; }
        BUS(sd_bus_message_close_container(message));
        BUS(sd_bus_message_close_container(message));
    }
    BUS(sd_bus_message_append(message, "(sv)", "PIDs", "au", 1, (uint32_t)getpid()));
    BUS(sd_bus_message_close_container(message));
    BUS(sd_bus_message_open_container(message, 'a', "(sa(sv))"));
    BUS(sd_bus_message_close_container(message));
    BUS(sd_bus_call(bus, message, 60 * 1000000ULL, &error, &reply));
    int64_t deadline = millis() + 60000;
    while (!wait.done) {
        if (millis() >= deadline) { r = -ETIMEDOUT; goto failed; }
        BUS(sd_bus_process(bus, NULL));
        if (!r) {
            int64_t remaining = deadline - millis();
            if (remaining <= 0) { r = -ETIMEDOUT; goto failed; }
            BUS(sd_bus_wait(bus, (uint64_t)remaining * 1000));
        }
    }
    if (wait.failed) { r = -EIO; goto failed; }
    goto identity;
failed:
    snprintf(scope_failure, sizeof(scope_failure), "foreground_scope_failed at %s: %s; command was not started", stage, error.message ? error.message : strerror(-r));
    fprintf(stderr, "%s\n", scope_failure);
    scope_status = -1;
identity:
    sd_bus_error_free(&error); sd_bus_message_unref(message); sd_bus_message_unref(reply); sd_bus_slot_unref(slot); sd_bus_unref(bus);
    if (!json_object_is_type(oom, json_type_null)) {
        int fd = open("/proc/self/oom_score_adj", O_WRONLY | O_CLOEXEC);
        char score[32]; int n = snprintf(score, sizeof(score), "%d", json_object_get_int(oom));
        if (fd < 0 || write(fd, score, (size_t)n) != n || close(fd)) { perror("foreground_oom_score_failed"); json_object_put(request); return -2; }
    }
    struct passwd *owner = getpwuid((uid_t)json_object_get_int64(uid));
    if (!owner || initgroups(owner->pw_name, (gid_t)json_object_get_int64(gid)) ||
        setresgid((gid_t)json_object_get_int64(gid), (gid_t)json_object_get_int64(gid), (gid_t)json_object_get_int64(gid)) ||
        setresuid(owner->pw_uid, owner->pw_uid, owner->pw_uid) || prctl(PR_SET_DUMPABLE, 1)) { perror("foreground_identity_failed"); json_object_put(request); return -2; }
    json_object_put(request); return scope_status;
#undef BUS
}
int main(int argc, char **argv) {
    int scope_status = 0;
    if (argc == 4 && !strcmp(argv[1], "--scope")) {
        scope_status = enter_scope(argv[2]);
        if (scope_status == -2) return 125;
        job_path = argv[3];
    } else if (argc == 2) job_path = argv[1];
    else return 127;
    char *result_path = suffix(".result");
    if (access(result_path, F_OK) == 0) return 0;
    free(result_path);
    struct json_object *job = json_object_from_file(job_path);
    if (!job) failure("invalid job JSON");
    output = open(string_field(job, "output"), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (output < 0) failure(strerror(errno));
    if (scope_status) failure(scope_failure);
    int64_t started = millis();
    struct json_object *start = json_object_new_object();
    json_object_object_add(start, "started", json_object_new_int64(started));
    json_object_object_add(start, "pid", json_object_new_int(getpid()));
    publish(".started", start); json_object_put(start);
    const char *requested = cancellation();
    if (requested) { finish(!strcmp(requested, "timeout") ? 124 : 130, 0, requested); return 0; }
    struct json_object *timeout, *env;
    if (!json_object_object_get_ex(job, "timeout", &timeout) ||
        (!json_object_is_type(timeout, json_type_double) && !json_object_is_type(timeout, json_type_int)) ||
        !json_object_object_get_ex(job, "env", &env) || !json_object_is_type(env, json_type_object)) failure("invalid job timeout or environment");
    double seconds = json_object_get_double(timeout);
    int64_t deadline = started + (int64_t)(seconds * 1000);
    const char *command = string_field(job, "command"), *home = string_field(job, "home");
    clearenv();
    json_object_object_foreach(env, key, value) {
        if (!strcmp(key, "KENAN_TRACKED_BACKGROUND") || !strcmp(key, "KENAN_BASH_DEADLINE_UNIX_MS")) continue;
        if (!json_object_is_type(value, json_type_string) || strchr(key, '=') || !*key ||
            (size_t)json_object_get_string_len(value) != strlen(json_object_get_string(value))) failure("invalid job environment value");
        if (setenv(key, json_object_get_string(value), 1)) failure(strerror(errno));
    }
    char deadline_text[32]; snprintf(deadline_text, sizeof(deadline_text), "%lld", (long long)deadline);
    if (setenv("KENAN_BASH_DEADLINE_UNIX_MS", deadline_text, 1)) failure(strerror(errno));
    sigset_t signals, previous;
    sigemptyset(&signals); sigaddset(&signals, SIGCHLD);
    if (sigprocmask(SIG_BLOCK, &signals, &previous)) failure(strerror(errno));
    int notify = inotify_init1(IN_NONBLOCK | IN_CLOEXEC), timer = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC), child_signal = signalfd(-1, &signals, SFD_CLOEXEC);
    if (notify < 0 || timer < 0 || child_signal < 0) failure(strerror(errno));
    char *directory = strdup(job_path), *slash = strrchr(directory, '/');
    if (slash) { if (slash == directory) slash[1] = 0; else *slash = 0; } else { free(directory); directory = strdup("."); }
    if (inotify_add_watch(notify, directory, IN_MOVED_TO | IN_CLOSE_WRITE | IN_CREATE) < 0) failure(strerror(errno));
    free(directory);
    int errors[2];
    if (pipe2(errors, O_CLOEXEC)) failure(strerror(errno));
    pid_t child = fork();
    if (child < 0) failure(strerror(errno));
    if (!child) {
        close(errors[0]);
        if (setsid() < 0 || chdir(home) || dup2(output, STDOUT_FILENO) < 0 || dup2(output, STDERR_FILENO) < 0) goto exec_failed;
        int input = open("/dev/null", O_RDONLY);
        if (input < 0 || dup2(input, STDIN_FILENO) < 0) goto exec_failed;
        if (input != STDIN_FILENO) close(input);
        for (int sig = 1; sig < NSIG; sig++) if (sig != SIGKILL && sig != SIGSTOP) signal(sig, SIG_DFL);
        if (sigprocmask(SIG_SETMASK, &previous, NULL)) goto exec_failed;
        execl("/bin/bash", "/bin/bash", "-c", command, (char *)NULL);
exec_failed:;
        int error = errno;
        if (write(errors[1], &error, sizeof(error)) != sizeof(error)) _exit(127);
        _exit(127);
    }
    close(errors[1]);
    int error = 0;
    ssize_t received;
    do { received = read(errors[0], &error, sizeof(error)); } while (received < 0 && errno == EINTR);
    close(errors[0]);
    if (received > 0) { waitpid(child, NULL, 0); failure(strerror(error)); }
    arm(timer, (deadline - millis()) / 1000.0);
    struct pollfd fds[] = {{child_signal, POLLIN, 0}, {notify, POLLIN, 0}, {timer, POLLIN, 0}};
    int status;
    for (;;) {
        pid_t reaped = waitpid(child, &status, WNOHANG);
        if (reaped == child) break;
        if (reaped < 0 && errno != EINTR) failure(strerror(errno));
        const char *reason = requested ? NULL : cancellation();
        if (reason) { requested = reason; kill(-child, SIGTERM); arm(timer, 1); }
        if (poll(fds, 3, -1) < 0) { if (errno == EINTR) continue; failure(strerror(errno)); }
        if (fds[0].revents & POLLIN) { struct signalfd_siginfo info; if (read(child_signal, &info, sizeof(info)) < 0 && errno != EINTR) failure(strerror(errno)); }
        if (fds[1].revents & POLLIN) { char events[8192]; while (read(notify, events, sizeof(events)) > 0) {} }
        if (fds[2].revents & POLLIN) {
            uint64_t expired; if (read(timer, &expired, sizeof(expired)) < 0) { if (errno == EINTR) continue; failure(strerror(errno)); }
            if (!requested) { requested = "timeout"; kill(-child, SIGTERM); arm(timer, 1); }
            else kill(-child, SIGKILL);
        }
    }
    if (requested) kill(-child, SIGKILL);
    int sig = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
    finish(sig ? 128 + sig : WEXITSTATUS(status), sig, requested ? requested : sig ? "signal" : "exit");
    return 0;
}
