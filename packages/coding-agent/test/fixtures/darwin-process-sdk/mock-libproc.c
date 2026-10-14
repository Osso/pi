#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <sys/proc_info.h>

int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  (void)arg;
  if (flavor != PROC_PIDTBSDINFO || size != (int)sizeof(struct proc_bsdinfo)) {
    errno = EINVAL;
    return 0;
  }
  if (pid == 4202 || pid == 4203) {
    errno = pid == 4202 ? ESRCH : EPERM;
    return 0;
  }
  if (pid == 4204)
    return size - 1;
  struct proc_bsdinfo *info = buffer;
  memset(info, 0, sizeof(*info));
  info->pbi_pid = (uint32_t)pid;
  info->pbi_status = pid == 4201 ? 5 : 2;
  info->pbi_pgid = 5300;
  info->pbi_start_tvsec = pid == 4205 ? 0 : 1792000000;
  info->pbi_start_tvusec = pid == 4205 ? 0 : 123456;
  if (pid == 4206)
    info->pbi_start_tvsec = UINT64_MAX;
  return size;
}
