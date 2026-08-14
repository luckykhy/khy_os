/* string.h — Freestanding libc string functions * @pattern Strategy
 */
#ifndef STRING_H
#define STRING_H

#include <stdint.h>
#include <stddef.h>

void *memset(void *dest, int val, size_t len);
void *memcpy(void *dest, const void *src, size_t len);
void *memmove(void *dest, const void *src, size_t len);
int   memcmp(const void *s1, const void *s2, size_t len);
size_t strlen(const char *s);
int   strcmp(const char *s1, const char *s2);
int   strncmp(const char *s1, const char *s2, size_t n);

#endif
