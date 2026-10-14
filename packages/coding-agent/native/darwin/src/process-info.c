#include <dlfcn.h>
#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/proc_info.h>

#define NAPI_AUTO_LENGTH ((size_t)-1)
#define MAX_SAFE_INTEGER UINT64_C(9007199254740991)
#define MICROS_PER_SECOND UINT64_C(1000000)
#define DARWIN_ZOMBIE_STATE 5

typedef void *napi_env;
typedef void *napi_value;
typedef void *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
typedef int (*create_function_fn)(napi_env, const char *, size_t, napi_callback,
                                  void *, napi_value *);
typedef int (*set_property_fn)(napi_env, napi_value, const char *, napi_value);
typedef int (*create_object_fn)(napi_env, napi_value *);
typedef int (*create_double_fn)(napi_env, double, napi_value *);
typedef int (*create_string_fn)(napi_env, const char *, size_t, napi_value *);
typedef int (*get_callback_info_fn)(napi_env, napi_callback_info, size_t *,
                                    napi_value *, napi_value *, void **);
typedef int (*get_double_fn)(napi_env, napi_value, double *);
typedef int (*throw_error_fn)(napi_env, const char *, const char *);

struct napi_functions {
  create_function_fn create_function;
  set_property_fn set_property;
  create_object_fn create_object;
  create_double_fn create_double;
  create_string_fn create_string;
  get_callback_info_fn get_callback_info;
  get_double_fn get_double;
  throw_error_fn throw_error;
};

static struct napi_functions napi;

static bool load_napi(void) {
  napi.create_function =
      (create_function_fn)dlsym(RTLD_DEFAULT, "napi_create_function");
  napi.set_property =
      (set_property_fn)dlsym(RTLD_DEFAULT, "napi_set_named_property");
  napi.create_object =
      (create_object_fn)dlsym(RTLD_DEFAULT, "napi_create_object");
  napi.create_double =
      (create_double_fn)dlsym(RTLD_DEFAULT, "napi_create_double");
  napi.create_string =
      (create_string_fn)dlsym(RTLD_DEFAULT, "napi_create_string_utf8");
  napi.get_callback_info =
      (get_callback_info_fn)dlsym(RTLD_DEFAULT, "napi_get_cb_info");
  napi.get_double = (get_double_fn)dlsym(RTLD_DEFAULT, "napi_get_value_double");
  napi.throw_error = (throw_error_fn)dlsym(RTLD_DEFAULT, "napi_throw_error");
  return napi.create_function && napi.set_property && napi.create_object &&
         napi.create_double && napi.create_string && napi.get_callback_info &&
         napi.get_double && napi.throw_error;
}

static napi_value fail(napi_env env, const char *code, const char *message) {
  if (napi.throw_error)
    napi.throw_error(env, code, message);
  return NULL;
}

static const char *inspection_error_code(int error) {
  if (error == ESRCH)
    return "ESRCH";
  if (error == EPERM)
    return "EPERM";
  if (error == EACCES)
    return "EACCES";
  if (error == EINVAL)
    return "EINVAL";
  return "EIO";
}

static bool read_pid_argument(napi_env env, napi_callback_info info, int *pid) {
  size_t count = 1;
  napi_value arguments[1] = {NULL};
  double argument = 0;
  if (napi.get_callback_info(env, info, &count, arguments, NULL, NULL) != 0 ||
      count != 1)
    return false;
  if (napi.get_double(env, arguments[0], &argument) != 0)
    return false;
  if (!isfinite(argument) || argument < 1 || argument > INT_MAX)
    return false;
  if (argument != (double)(int)argument)
    return false;
  *pid = (int)argument;
  return true;
}

static bool creation_marker(const struct proc_bsdinfo *info, uint64_t *marker) {
  if (info->pbi_start_tvusec >= MICROS_PER_SECOND)
    return false;
  if (info->pbi_start_tvsec > MAX_SAFE_INTEGER / MICROS_PER_SECOND)
    return false;
  *marker = info->pbi_start_tvsec * MICROS_PER_SECOND + info->pbi_start_tvusec;
  return *marker > 0 && *marker <= MAX_SAFE_INTEGER;
}

static bool set_number(napi_env env, napi_value object, const char *name,
                       double number) {
  napi_value value = NULL;
  return napi.create_double(env, number, &value) == 0 &&
         napi.set_property(env, object, name, value) == 0;
}

static napi_value process_result(napi_env env, int pid,
                                 const struct proc_bsdinfo *info,
                                 uint64_t marker) {
  napi_value object = NULL;
  napi_value state = NULL;
  const char *label = info->pbi_status == DARWIN_ZOMBIE_STATE ? "Z" : "R";
  if (napi.create_object(env, &object) != 0)
    return fail(env, "ERR_NAPI", "Could not create process information");
  if (!set_number(env, object, "pid", pid) ||
      !set_number(env, object, "startTimeTicks", (double)marker) ||
      !set_number(env, object, "processGroupId", info->pbi_pgid)) {
    return fail(env, "ERR_NAPI", "Could not encode process information");
  }
  if (napi.create_string(env, label, NAPI_AUTO_LENGTH, &state) != 0 ||
      napi.set_property(env, object, "state", state) != 0) {
    return fail(env, "ERR_NAPI", "Could not encode process state");
  }
  return object;
}

static napi_value read_process_info(napi_env env, napi_callback_info callback) {
  int pid = 0;
  if (!read_pid_argument(env, callback, &pid))
    return fail(env, "EINVAL", "Expected a positive integer PID");
  struct proc_bsdinfo info;
  memset(&info, 0, sizeof(info));
  errno = 0;
  int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (bytes == 0) {
    int error = errno;
    char message[128];
    snprintf(message, sizeof(message), "Could not inspect process %d: %s", pid,
             strerror(error ? error : EIO));
    return fail(env, inspection_error_code(error), message);
  }
  if (bytes != (int)sizeof(info) || info.pbi_pid != (uint32_t)pid) {
    return fail(env, "EIO", "Incomplete native process information");
  }
  uint64_t marker = 0;
  if (!creation_marker(&info, &marker))
    return fail(env, "ERANGE", "Native process creation marker is not exact");
  return process_result(env, pid, &info, marker);
}

__attribute__((visibility("default"))) napi_value
napi_register_module_v1(napi_env env, napi_value exports) {
  if (!load_napi())
    return fail(env, "ERR_NAPI",
                "Required process N-API functions are unavailable");
  napi_value function = NULL;
  if (napi.create_function(env, "readProcessInfo", NAPI_AUTO_LENGTH,
                           read_process_info, NULL, &function) != 0 ||
      napi.set_property(env, exports, "readProcessInfo", function) != 0) {
    return fail(env, "ERR_NAPI",
                "Could not register native process inspection");
  }
  return exports;
}
