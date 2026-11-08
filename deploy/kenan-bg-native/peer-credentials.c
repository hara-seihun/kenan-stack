#define _GNU_SOURCE
#include <node_api.h>
#include <sys/socket.h>
#include <unistd.h>

// Read the connected Unix socket's peer from the kernel, never a request field.
static napi_value credentials(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value arg, result, value;
  int32_t fd;
  struct ucred peer;
  socklen_t size = sizeof(peer);
  if (napi_get_cb_info(env, info, &count, &arg, NULL, NULL) != napi_ok || count != 1 ||
      napi_get_value_int32(env, arg, &fd) != napi_ok || fd < 0 ||
      getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) != 0 || size != sizeof(peer)) {
    napi_throw_error(env, NULL, "background_invalid_peer");
    return NULL;
  }
  napi_create_object(env, &result);
  napi_create_int64(env, peer.pid, &value);
  napi_set_named_property(env, result, "pid", value);
  napi_create_uint32(env, peer.uid, &value);
  napi_set_named_property(env, result, "uid", value);
  napi_create_uint32(env, peer.gid, &value);
  napi_set_named_property(env, result, "gid", value);
  return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "credentials", NAPI_AUTO_LENGTH, credentials, NULL, &function);
  napi_set_named_property(env, exports, "credentials", function);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
