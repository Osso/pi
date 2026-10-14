#ifndef PI_TEST_LIBPROC_H
#define PI_TEST_LIBPROC_H
#include <stdint.h>
int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size);
#endif
