#ifndef PI_TEST_PROC_INFO_H
#define PI_TEST_PROC_INFO_H
#include <stdint.h>
#define PROC_PIDTBSDINFO 3
struct proc_bsdinfo {
  uint32_t pbi_status;
  uint32_t pbi_pid;
  uint32_t pbi_pgid;
  uint64_t pbi_start_tvsec;
  uint64_t pbi_start_tvusec;
};
#endif
