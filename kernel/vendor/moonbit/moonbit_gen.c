#ifdef __cplusplus
extern "C" {
#endif

#include "moonbit.h"

#ifdef _MSC_VER
#define _Noreturn __declspec(noreturn)
#endif

#if defined(__clang__)
#pragma clang diagnostic ignored "-Wshift-op-parentheses"
#pragma clang diagnostic ignored "-Wtautological-compare"
#endif

MOONBIT_EXPORT _Noreturn void moonbit_panic(void);
MOONBIT_EXPORT void *moonbit_malloc_array(enum moonbit_block_kind kind,
                                          int elem_size_shift, int32_t len);
MOONBIT_EXPORT int moonbit_val_array_equal(const void *lhs, const void *rhs);
MOONBIT_EXPORT moonbit_string_t moonbit_add_string(moonbit_string_t s1,
                                                   moonbit_string_t s2);
MOONBIT_EXPORT void moonbit_unsafe_bytes_blit(moonbit_bytes_t dst,
                                              int32_t dst_start,
                                              moonbit_bytes_t src,
                                              int32_t src_offset, int32_t len);
MOONBIT_EXPORT moonbit_string_t moonbit_unsafe_bytes_sub_string(
    moonbit_bytes_t bytes, int32_t start, int32_t len);
MOONBIT_EXPORT void moonbit_println(moonbit_string_t str);
MOONBIT_EXPORT moonbit_bytes_t *moonbit_get_cli_args(void);
MOONBIT_EXPORT void moonbit_runtime_init(int argc, char **argv);
MOONBIT_EXPORT void moonbit_drop_object(void *);

#define Moonbit_make_regular_object_header(ptr_field_offset, ptr_field_count,  \
                                           tag)                                \
  (((uint32_t)moonbit_BLOCK_KIND_REGULAR << 30) |                              \
   (((uint32_t)(ptr_field_offset) & (((uint32_t)1 << 11) - 1)) << 19) |        \
   (((uint32_t)(ptr_field_count) & (((uint32_t)1 << 11) - 1)) << 8) |          \
   ((tag) & 0xFF))

// header manipulation macros
#define Moonbit_object_ptr_field_offset(obj)                                   \
  ((Moonbit_object_header(obj)->meta >> 19) & (((uint32_t)1 << 11) - 1))

#define Moonbit_object_ptr_field_count(obj)                                    \
  ((Moonbit_object_header(obj)->meta >> 8) & (((uint32_t)1 << 11) - 1))

#if !defined(_WIN64) && !defined(_WIN32)
void *malloc(size_t size);
void free(void *ptr);
#define libc_malloc malloc
#define libc_free free
#endif

// several important runtime functions are inlined
static void *moonbit_malloc_inlined(size_t size) {
  struct moonbit_object *ptr = (struct moonbit_object *)libc_malloc(
      sizeof(struct moonbit_object) + size);
  ptr->rc = 1;
  return ptr + 1;
}

#define moonbit_malloc(obj) moonbit_malloc_inlined(obj)
#define moonbit_free(obj) libc_free(Moonbit_object_header(obj))

static void moonbit_incref_inlined(void *ptr) {
  struct moonbit_object *header = Moonbit_object_header(ptr);
  int32_t const count = header->rc;
  if (count > 0) {
    header->rc = count + 1;
  }
}

#define moonbit_incref moonbit_incref_inlined

static void moonbit_decref_inlined(void *ptr) {
  struct moonbit_object *header = Moonbit_object_header(ptr);
  int32_t const count = header->rc;
  if (count > 1) {
    header->rc = count - 1;
  } else if (count == 1) {
    moonbit_drop_object(ptr);
  }
}

#define moonbit_decref moonbit_decref_inlined

#define moonbit_unsafe_make_string moonbit_make_string

// detect whether compiler builtins exist for advanced bitwise operations
#ifdef __has_builtin

#if __has_builtin(__builtin_clz)
#define HAS_BUILTIN_CLZ
#endif

#if __has_builtin(__builtin_ctz)
#define HAS_BUILTIN_CTZ
#endif

#if __has_builtin(__builtin_popcount)
#define HAS_BUILTIN_POPCNT
#endif

#if __has_builtin(__builtin_sqrt)
#define HAS_BUILTIN_SQRT
#endif

#if __has_builtin(__builtin_sqrtf)
#define HAS_BUILTIN_SQRTF
#endif

#if __has_builtin(__builtin_fabs)
#define HAS_BUILTIN_FABS
#endif

#if __has_builtin(__builtin_fabsf)
#define HAS_BUILTIN_FABSF
#endif

#endif

// if there is no builtin operators, use software implementation
#ifdef HAS_BUILTIN_CLZ
static inline int32_t moonbit_clz32(int32_t x) {
  return x == 0 ? 32 : __builtin_clz(x);
}

static inline int32_t moonbit_clz64(int64_t x) {
  return x == 0 ? 64 : __builtin_clzll(x);
}

#undef HAS_BUILTIN_CLZ
#else
// table for [clz] value of 4bit integer.
static const uint8_t moonbit_clz4[] = {4, 3, 2, 2, 1, 1, 1, 1,
                                       0, 0, 0, 0, 0, 0, 0, 0};

int32_t moonbit_clz32(uint32_t x) {
  /* The ideas is to:

     1. narrow down the 4bit block where the most signficant "1" bit lies,
        using binary search
     2. find the number of leading zeros in that 4bit block via table lookup

     Different time/space tradeoff can be made here by enlarging the table
     and do less binary search.
     One benefit of the 4bit lookup table is that it can fit into a single cache
     line.
  */
  int32_t result = 0;
  if (x > 0xffff) {
    x >>= 16;
  } else {
    result += 16;
  }
  if (x > 0xff) {
    x >>= 8;
  } else {
    result += 8;
  }
  if (x > 0xf) {
    x >>= 4;
  } else {
    result += 4;
  }
  return result + moonbit_clz4[x];
}

int32_t moonbit_clz64(uint64_t x) {
  int32_t result = 0;
  if (x > 0xffffffff) {
    x >>= 32;
  } else {
    result += 32;
  }
  return result + moonbit_clz32((uint32_t)x);
}
#endif

#ifdef HAS_BUILTIN_CTZ
static inline int32_t moonbit_ctz32(int32_t x) {
  return x == 0 ? 32 : __builtin_ctz(x);
}

static inline int32_t moonbit_ctz64(int64_t x) {
  return x == 0 ? 64 : __builtin_ctzll(x);
}

#undef HAS_BUILTIN_CTZ
#else
int32_t moonbit_ctz32(int32_t x) {
  /* The algorithm comes from:

       Leiserson, Charles E. et al. “Using de Bruijn Sequences to Index a 1 in a
     Computer Word.” (1998).

     The ideas is:

     1. leave only the least significant "1" bit in the input,
        set all other bits to "0". This is achieved via [x & -x]
     2. now we have [x * n == n << ctz(x)], if [n] is a de bruijn sequence
        (every 5bit pattern occurn exactly once when you cycle through the bit
     string), we can find [ctz(x)] from the most significant 5 bits of [x * n]
 */
  static const uint32_t de_bruijn_32 = 0x077CB531;
  static const uint8_t index32[] = {0,  1,  28, 2,  29, 14, 24, 3,  30, 22, 20,
                                    15, 25, 17, 4,  8,  31, 27, 13, 23, 21, 19,
                                    16, 7,  26, 12, 18, 6,  11, 5,  10, 9};
  return (x == 0) * 32 + index32[(de_bruijn_32 * (x & -x)) >> 27];
}

int32_t moonbit_ctz64(int64_t x) {
  static const uint64_t de_bruijn_64 = 0x0218A392CD3D5DBF;
  static const uint8_t index64[] = {
      0,  1,  2,  7,  3,  13, 8,  19, 4,  25, 14, 28, 9,  34, 20, 40,
      5,  17, 26, 38, 15, 46, 29, 48, 10, 31, 35, 54, 21, 50, 41, 57,
      63, 6,  12, 18, 24, 27, 33, 39, 16, 37, 45, 47, 30, 53, 49, 56,
      62, 11, 23, 32, 36, 44, 52, 55, 61, 22, 43, 51, 60, 42, 59, 58};
  return (x == 0) * 64 + index64[(de_bruijn_64 * (x & -x)) >> 58];
}
#endif

#ifdef HAS_BUILTIN_POPCNT

#define moonbit_popcnt32 __builtin_popcount
#define moonbit_popcnt64 __builtin_popcountll
#undef HAS_BUILTIN_POPCNT

#else
int32_t moonbit_popcnt32(uint32_t x) {
  /* The classic SIMD Within A Register algorithm.
     ref: [https://nimrod.blog/posts/algorithms-behind-popcount/]
 */
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0F0F0F0F;
  return (x * 0x01010101) >> 24;
}

int32_t moonbit_popcnt64(uint64_t x) {
  x = x - ((x >> 1) & 0x5555555555555555);
  x = (x & 0x3333333333333333) + ((x >> 2) & 0x3333333333333333);
  x = (x + (x >> 4)) & 0x0F0F0F0F0F0F0F0F;
  return (x * 0x0101010101010101) >> 56;
}
#endif

/* The following sqrt implementation comes from
   [musl](https://git.musl-libc.org/cgit/musl),
   with some helpers inlined to make it zero dependency.
 */
#ifdef MOONBIT_NATIVE_NO_SYS_HEADER
const uint16_t __rsqrt_tab[128] = {
    0xb451, 0xb2f0, 0xb196, 0xb044, 0xaef9, 0xadb6, 0xac79, 0xab43, 0xaa14,
    0xa8eb, 0xa7c8, 0xa6aa, 0xa592, 0xa480, 0xa373, 0xa26b, 0xa168, 0xa06a,
    0x9f70, 0x9e7b, 0x9d8a, 0x9c9d, 0x9bb5, 0x9ad1, 0x99f0, 0x9913, 0x983a,
    0x9765, 0x9693, 0x95c4, 0x94f8, 0x9430, 0x936b, 0x92a9, 0x91ea, 0x912e,
    0x9075, 0x8fbe, 0x8f0a, 0x8e59, 0x8daa, 0x8cfe, 0x8c54, 0x8bac, 0x8b07,
    0x8a64, 0x89c4, 0x8925, 0x8889, 0x87ee, 0x8756, 0x86c0, 0x862b, 0x8599,
    0x8508, 0x8479, 0x83ec, 0x8361, 0x82d8, 0x8250, 0x81c9, 0x8145, 0x80c2,
    0x8040, 0xff02, 0xfd0e, 0xfb25, 0xf947, 0xf773, 0xf5aa, 0xf3ea, 0xf234,
    0xf087, 0xeee3, 0xed47, 0xebb3, 0xea27, 0xe8a3, 0xe727, 0xe5b2, 0xe443,
    0xe2dc, 0xe17a, 0xe020, 0xdecb, 0xdd7d, 0xdc34, 0xdaf1, 0xd9b3, 0xd87b,
    0xd748, 0xd61a, 0xd4f1, 0xd3cd, 0xd2ad, 0xd192, 0xd07b, 0xcf69, 0xce5b,
    0xcd51, 0xcc4a, 0xcb48, 0xca4a, 0xc94f, 0xc858, 0xc764, 0xc674, 0xc587,
    0xc49d, 0xc3b7, 0xc2d4, 0xc1f4, 0xc116, 0xc03c, 0xbf65, 0xbe90, 0xbdbe,
    0xbcef, 0xbc23, 0xbb59, 0xba91, 0xb9cc, 0xb90a, 0xb84a, 0xb78c, 0xb6d0,
    0xb617, 0xb560,
};

/* returns a*b*2^-32 - e, with error 0 <= e < 1.  */
static inline uint32_t mul32(uint32_t a, uint32_t b) {
  return (uint64_t)a * b >> 32;
}
#endif

#ifdef MOONBIT_NATIVE_NO_SYS_HEADER
float sqrtf(float x) {
  uint32_t ix, m, m1, m0, even, ey;

  ix = *(uint32_t *)&x;
  if (ix - 0x00800000 >= 0x7f800000 - 0x00800000) {
    /* x < 0x1p-126 or inf or nan.  */
    if (ix * 2 == 0)
      return x;
    if (ix == 0x7f800000)
      return x;
    if (ix > 0x7f800000)
      return (x - x) / (x - x);
    /* x is subnormal, normalize it.  */
    x *= 0x1p23f;
    ix = *(uint32_t *)&x;
    ix -= 23 << 23;
  }

  /* x = 4^e m; with int e and m in [1, 4).  */
  even = ix & 0x00800000;
  m1 = (ix << 8) | 0x80000000;
  m0 = (ix << 7) & 0x7fffffff;
  m = even ? m0 : m1;

  /* 2^e is the exponent part of the return value.  */
  ey = ix >> 1;
  ey += 0x3f800000 >> 1;
  ey &= 0x7f800000;

  /* compute r ~ 1/sqrt(m), s ~ sqrt(m) with 2 goldschmidt iterations.  */
  static const uint32_t three = 0xc0000000;
  uint32_t r, s, d, u, i;
  i = (ix >> 17) % 128;
  r = (uint32_t)__rsqrt_tab[i] << 16;
  /* |r*sqrt(m) - 1| < 0x1p-8 */
  s = mul32(m, r);
  /* |s/sqrt(m) - 1| < 0x1p-8 */
  d = mul32(s, r);
  u = three - d;
  r = mul32(r, u) << 1;
  /* |r*sqrt(m) - 1| < 0x1.7bp-16 */
  s = mul32(s, u) << 1;
  /* |s/sqrt(m) - 1| < 0x1.7bp-16 */
  d = mul32(s, r);
  u = three - d;
  s = mul32(s, u);
  /* -0x1.03p-28 < s/sqrt(m) - 1 < 0x1.fp-31 */
  s = (s - 1) >> 6;
  /* s < sqrt(m) < s + 0x1.08p-23 */

  /* compute nearest rounded result.  */
  uint32_t d0, d1, d2;
  float y, t;
  d0 = (m << 16) - s * s;
  d1 = s - d0;
  d2 = d1 + s + 1;
  s += d1 >> 31;
  s &= 0x007fffff;
  s |= ey;
  y = *(float *)&s;
  /* handle rounding and inexact exception. */
  uint32_t tiny = d2 == 0 ? 0 : 0x01000000;
  tiny |= (d1 ^ d2) & 0x80000000;
  t = *(float *)&tiny;
  y = y + t;
  return y;
}
#endif

#ifdef MOONBIT_NATIVE_NO_SYS_HEADER
/* returns a*b*2^-64 - e, with error 0 <= e < 3.  */
static inline uint64_t mul64(uint64_t a, uint64_t b) {
  uint64_t ahi = a >> 32;
  uint64_t alo = a & 0xffffffff;
  uint64_t bhi = b >> 32;
  uint64_t blo = b & 0xffffffff;
  return ahi * bhi + (ahi * blo >> 32) + (alo * bhi >> 32);
}

double sqrt(double x) {
  uint64_t ix, top, m;

  /* special case handling.  */
  ix = *(uint64_t *)&x;
  top = ix >> 52;
  if (top - 0x001 >= 0x7ff - 0x001) {
    /* x < 0x1p-1022 or inf or nan.  */
    if (ix * 2 == 0)
      return x;
    if (ix == 0x7ff0000000000000)
      return x;
    if (ix > 0x7ff0000000000000)
      return (x - x) / (x - x);
    /* x is subnormal, normalize it.  */
    x *= 0x1p52;
    ix = *(uint64_t *)&x;
    top = ix >> 52;
    top -= 52;
  }

  /* argument reduction:
     x = 4^e m; with integer e, and m in [1, 4)
     m: fixed point representation [2.62]
     2^e is the exponent part of the result.  */
  int even = top & 1;
  m = (ix << 11) | 0x8000000000000000;
  if (even)
    m >>= 1;
  top = (top + 0x3ff) >> 1;

  /* approximate r ~ 1/sqrt(m) and s ~ sqrt(m) when m in [1,4)

     initial estimate:
     7bit table lookup (1bit exponent and 6bit significand).

     iterative approximation:
     using 2 goldschmidt iterations with 32bit int arithmetics
     and a final iteration with 64bit int arithmetics.

     details:

     the relative error (e = r0 sqrt(m)-1) of a linear estimate
     (r0 = a m + b) is |e| < 0.085955 ~ 0x1.6p-4 at best,
     a table lookup is faster and needs one less iteration
     6 bit lookup table (128b) gives |e| < 0x1.f9p-8
     7 bit lookup table (256b) gives |e| < 0x1.fdp-9
     for single and double prec 6bit is enough but for quad
     prec 7bit is needed (or modified iterations). to avoid
     one more iteration >=13bit table would be needed (16k).

     a newton-raphson iteration for r is
       w = r*r
       u = 3 - m*w
       r = r*u/2
     can use a goldschmidt iteration for s at the end or
       s = m*r

     first goldschmidt iteration is
       s = m*r
       u = 3 - s*r
       r = r*u/2
       s = s*u/2
     next goldschmidt iteration is
       u = 3 - s*r
       r = r*u/2
       s = s*u/2
     and at the end r is not computed only s.

     they use the same amount of operations and converge at the
     same quadratic rate, i.e. if
       r1 sqrt(m) - 1 = e, then
       r2 sqrt(m) - 1 = -3/2 e^2 - 1/2 e^3
     the advantage of goldschmidt is that the mul for s and r
     are independent (computed in parallel), however it is not
     "self synchronizing": it only uses the input m in the
     first iteration so rounding errors accumulate. at the end
     or when switching to larger precision arithmetics rounding
     errors dominate so the first iteration should be used.

     the fixed point representations are
       m: 2.30 r: 0.32, s: 2.30, d: 2.30, u: 2.30, three: 2.30
     and after switching to 64 bit
       m: 2.62 r: 0.64, s: 2.62, d: 2.62, u: 2.62, three: 2.62  */

  static const uint64_t three = 0xc0000000;
  uint64_t r, s, d, u, i;

  i = (ix >> 46) % 128;
  r = (uint32_t)__rsqrt_tab[i] << 16;
  /* |r sqrt(m) - 1| < 0x1.fdp-9 */
  s = mul32(m >> 32, r);
  /* |s/sqrt(m) - 1| < 0x1.fdp-9 */
  d = mul32(s, r);
  u = three - d;
  r = mul32(r, u) << 1;
  /* |r sqrt(m) - 1| < 0x1.7bp-16 */
  s = mul32(s, u) << 1;
  /* |s/sqrt(m) - 1| < 0x1.7bp-16 */
  d = mul32(s, r);
  u = three - d;
  r = mul32(r, u) << 1;
  /* |r sqrt(m) - 1| < 0x1.3704p-29 (measured worst-case) */
  r = r << 32;
  s = mul64(m, r);
  d = mul64(s, r);
  u = (three << 32) - d;
  s = mul64(s, u); /* repr: 3.61 */
  /* -0x1p-57 < s - sqrt(m) < 0x1.8001p-61 */
  s = (s - 2) >> 9; /* repr: 12.52 */
  /* -0x1.09p-52 < s - sqrt(m) < -0x1.fffcp-63 */

  /* s < sqrt(m) < s + 0x1.09p-52,
     compute nearest rounded result:
     the nearest result to 52 bits is either s or s+0x1p-52,
     we can decide by comparing (2^52 s + 0.5)^2 to 2^104 m.  */
  uint64_t d0, d1, d2;
  double y, t;
  d0 = (m << 42) - s * s;
  d1 = s - d0;
  d2 = d1 + s + 1;
  s += d1 >> 63;
  s &= 0x000fffffffffffff;
  s |= top << 52;
  y = *(double *)&s;
  return y;
}
#endif

#ifdef MOONBIT_NATIVE_NO_SYS_HEADER
double fabs(double x) {
  union {
    double f;
    uint64_t i;
  } u = {x};
  u.i &= 0x7fffffffffffffffULL;
  return u.f;
}
#endif

#ifdef MOONBIT_NATIVE_NO_SYS_HEADER
float fabsf(float x) {
  union {
    float f;
    uint32_t i;
  } u = {x};
  u.i &= 0x7fffffff;
  return u.f;
}
#endif

#ifdef _MSC_VER
/* MSVC treats syntactic division by zero as fatal error,
   even for float point numbers,
   so we have to use a constant variable to work around this */
static const int MOONBIT_ZERO = 0;
#else
#define MOONBIT_ZERO 0
#endif

#ifdef __cplusplus
}
#endif
int32_t _M0FP47khy__os6kernel3lib11khy__kernel3fib(int32_t);

int32_t _M0FPB7printlnGsE(moonbit_string_t);

moonbit_string_t _M0IPC13int3IntPB4Show10to__string(int32_t);

moonbit_string_t _M0IPC16string6StringPB4Show10to__string(moonbit_string_t);

moonbit_string_t _M0MPC13int3Int18to__string_2einner(int32_t, int32_t);

int32_t _M0FPB14radix__count32(uint32_t, int32_t);

int32_t _M0FPB12hex__count32(uint32_t);

int32_t _M0FPB12dec__count32(uint32_t);

int32_t _M0FPB20int__to__string__dec(uint16_t*, uint32_t, int32_t, int32_t);

int32_t _M0FPB24int__to__string__generic(
  uint16_t*,
  uint32_t,
  int32_t,
  int32_t,
  int32_t
);

int32_t _M0FPB20int__to__string__hex(uint16_t*, uint32_t, int32_t, int32_t);

int32_t _M0FPC15abort5abortGuE(moonbit_string_t);

struct { int32_t rc; uint32_t meta; uint16_t const data[35]; 
} const moonbit_string_literal_5 =
  {
    -1, Moonbit_make_array_header(moonbit_BLOCK_KIND_VAL_ARRAY, 1, 34), 
    91, 77, 79, 79, 78, 66, 73, 84, 93, 32, 83, 121, 115, 116, 101, 109, 
    32, 76, 97, 110, 103, 117, 97, 103, 101, 58, 32, 77, 111, 111, 110, 
    66, 105, 116, 0
  };

struct { int32_t rc; uint32_t meta; uint16_t const data[21]; 
} const moonbit_string_literal_9 =
  {
    -1, Moonbit_make_array_header(moonbit_BLOCK_KIND_VAL_ARRAY, 1, 20), 
    91, 77, 79, 79, 78, 66, 73, 84, 93, 32, 102, 105, 98, 40, 50, 48, 
    41, 32, 61, 32, 0
  };

struct { int32_t rc; uint32_t meta; uint16_t const data[42]; 
} const moonbit_string_literal_8 =
  {
    -1, Moonbit_make_array_header(moonbit_BLOCK_KIND_VAL_ARRAY, 1, 41), 
    91, 77, 79, 79, 78, 66, 73, 84, 93, 32, 67, 111, 109, 112, 117, 116, 
    105, 110, 103, 32, 70, 105, 98, 111, 110, 97, 99, 99, 105, 32, 115, 
    101, 113, 117, 101, 110, 99, 101, 46, 46, 46, 0
  };

struct { int32_t rc; uint32_t meta; uint16_t const data[38]; 
} const moonbit_string_literal_3 =
  {
    -1, Moonbit_make_array_header(moonbit_BLOCK_KIND_VAL_ARRAY, 1, 37), 
    91, 77, 79, 79, 78, 66, 73, 84, 93, 32, 77, 111, 111, 110, 66, 105, 
    116, 32, 114, 117, 110, 116, 105, 109, 101, 32, 105, 110, 105, 116, 
    105, 97, 108, 105, 122, 101, 100, 0
  };

struct { int32_t rc; uint32_t meta; uint16_t const data[31]; 
} const moonbit_string_literal_0 =
  {
    -1, Moonbit_make_array_header(moonbit_BLOCK_KIND_VAL_ARRAY, 1, 30), 
    114, 97, 100, 105, 120, 32, 109, 117, 115, 116, 32, 98, 101, 32, 
    98, 101, 116, 119, 101, 101, 110, 32, 50, 32, 97, 110, 100, 32, 51, 
    54, 0
  };

struct { int32_t rc; uint32_t meta; uint16_t const data[51]; 
} const moonbit_string_literal_10 =
  {
    -1, Moonbit_make_array_header(moonbit_BLOCK_KIND_VAL_ARRAY, 1, 50), 
    91, 77, 79, 79, 78, 66, 73, 84, 93, 32, 86, 105, 115, 105, 111, 110, 
    58, 32, 77, 105, 110, 105, 109, 97, 108, 32, 107, 101, 114, 110, 
    101, 108, 32, 43, 32, 87, 65, 83, 77, 32, 99, 111, 109, 112, 111, 
    110, 101, 110, 116, 115, 0
  };

struct { int32_t rc; uint32_t meta; uint16_t const data[47]; 
} const moonbit_string_literal_6 =
  {
    -1, Moonbit_make_array_header(moonbit_BLOCK_KIND_VAL_ARRAY, 1, 46), 
    91, 77, 79, 79, 78, 66, 73, 84, 93, 32, 84, 97, 114, 103, 101, 116, 
    58, 32, 78, 97, 116, 105, 118, 101, 32, 40, 102, 114, 101, 101, 115, 
    116, 97, 110, 100, 105, 110, 103, 32, 120, 56, 54, 95, 54, 52, 41, 
    0
  };

struct { int32_t rc; uint32_t meta; uint16_t const data[2]; 
} const moonbit_string_literal_1 =
  { -1, Moonbit_make_array_header(moonbit_BLOCK_KIND_VAL_ARRAY, 1, 1), 48, 0};

struct { int32_t rc; uint32_t meta; uint16_t const data[46]; 
} const moonbit_string_literal_4 =
  {
    -1, Moonbit_make_array_header(moonbit_BLOCK_KIND_VAL_ARRAY, 1, 45), 
    91, 77, 79, 79, 78, 66, 73, 84, 93, 32, 75, 72, 89, 32, 79, 83, 32, 
    77, 111, 111, 110, 66, 105, 116, 32, 107, 101, 114, 110, 101, 108, 
    32, 109, 111, 100, 117, 108, 101, 32, 118, 48, 46, 49, 46, 48, 0
  };

struct { int32_t rc; uint32_t meta; uint16_t const data[36]; 
} const moonbit_string_literal_11 =
  {
    -1, Moonbit_make_array_header(moonbit_BLOCK_KIND_VAL_ARRAY, 1, 35), 
    91, 77, 79, 79, 78, 66, 73, 84, 93, 32, 77, 111, 111, 110, 66, 105, 
    116, 32, 109, 111, 100, 117, 108, 101, 32, 99, 111, 109, 112, 108, 
    101, 116, 101, 100, 46, 0
  };

struct { int32_t rc; uint32_t meta; uint16_t const data[43]; 
} const moonbit_string_literal_7 =
  {
    -1, Moonbit_make_array_header(moonbit_BLOCK_KIND_VAL_ARRAY, 1, 42), 
    91, 77, 79, 79, 78, 66, 73, 84, 93, 32, 77, 101, 109, 111, 114, 121, 
    32, 77, 111, 100, 101, 108, 58, 32, 82, 101, 102, 101, 114, 101, 
    110, 99, 101, 32, 67, 111, 117, 110, 116, 105, 110, 103, 0
  };

struct { int32_t rc; uint32_t meta; uint16_t const data[37]; 
} const moonbit_string_literal_2 =
  {
    -1, Moonbit_make_array_header(moonbit_BLOCK_KIND_VAL_ARRAY, 1, 36), 
    48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102, 
    103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 
    116, 117, 118, 119, 120, 121, 122, 0
  };

int32_t _M0FP47khy__os6kernel3lib11khy__kernel3fib(int32_t _M0L1nS83) {
  #line 20 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  if (_M0L1nS83 <= 1) {
    return _M0L1nS83;
  } else {
    int32_t _M0L6_2atmpS168 = _M0L1nS83 - 1;
    int32_t _M0L6_2atmpS165;
    int32_t _M0L6_2atmpS167;
    int32_t _M0L6_2atmpS166;
    #line 24 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
    _M0L6_2atmpS165
    = _M0FP47khy__os6kernel3lib11khy__kernel3fib(_M0L6_2atmpS168);
    _M0L6_2atmpS167 = _M0L1nS83 - 2;
    #line 24 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
    _M0L6_2atmpS166
    = _M0FP47khy__os6kernel3lib11khy__kernel3fib(_M0L6_2atmpS167);
    return _M0L6_2atmpS165 + _M0L6_2atmpS166;
  }
}

int32_t _M0FPB7printlnGsE(moonbit_string_t _M0L5inputS82) {
  moonbit_string_t _M0L6_2atmpS164;
  #line 37 "/home/kodehu03/.moon/lib/core/builtin/console.mbt"
  #line 38 "/home/kodehu03/.moon/lib/core/builtin/console.mbt"
  _M0L6_2atmpS164 = _M0IPC16string6StringPB4Show10to__string(_M0L5inputS82);
  #line 38 "/home/kodehu03/.moon/lib/core/builtin/console.mbt"
  moonbit_println(_M0L6_2atmpS164);
  moonbit_decref(_M0L6_2atmpS164);
  return 0;
}

moonbit_string_t _M0IPC13int3IntPB4Show10to__string(int32_t _M0L4selfS81) {
  #line 45 "/home/kodehu03/.moon/lib/core/builtin/show.mbt"
  #line 46 "/home/kodehu03/.moon/lib/core/builtin/show.mbt"
  return _M0MPC13int3Int18to__string_2einner(_M0L4selfS81, 10);
}

moonbit_string_t _M0IPC16string6StringPB4Show10to__string(
  moonbit_string_t _M0L4selfS80
) {
  #line 262 "/home/kodehu03/.moon/lib/core/builtin/show.mbt"
  return _M0L4selfS80;
}

moonbit_string_t _M0MPC13int3Int18to__string_2einner(
  int32_t _M0L4selfS64,
  int32_t _M0L5radixS63
) {
  int32_t _if__result_169;
  int32_t _M0L12is__negativeS65;
  uint32_t _M0L3numS66;
  uint16_t* _M0L6bufferS67;
  #line 209 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
  if (_M0L5radixS63 < 2) {
    _if__result_169 = 1;
  } else {
    _if__result_169 = _M0L5radixS63 > 36;
  }
  if (_if__result_169) {
    #line 213 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
    _M0FPC15abort5abortGuE((moonbit_string_t)moonbit_string_literal_0.data);
  }
  if (_M0L4selfS64 == 0) {
    return (moonbit_string_t)moonbit_string_literal_1.data;
  }
  _M0L12is__negativeS65 = _M0L4selfS64 < 0;
  if (_M0L12is__negativeS65) {
    int32_t _M0L6_2atmpS163 = -_M0L4selfS64;
    _M0L3numS66 = *(uint32_t*)&_M0L6_2atmpS163;
  } else {
    _M0L3numS66 = *(uint32_t*)&_M0L4selfS64;
  }
  switch (_M0L5radixS63) {
    case 10: {
      int32_t _M0L10digit__lenS68;
      int32_t _M0L6_2atmpS160;
      int32_t _M0L10total__lenS69;
      uint16_t* _M0L6bufferS70;
      int32_t _M0L12digit__startS71;
      #line 235 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
      _M0L10digit__lenS68 = _M0FPB12dec__count32(_M0L3numS66);
      if (_M0L12is__negativeS65) {
        _M0L6_2atmpS160 = 1;
      } else {
        _M0L6_2atmpS160 = 0;
      }
      _M0L10total__lenS69 = _M0L10digit__lenS68 + _M0L6_2atmpS160;
      _M0L6bufferS70 = (uint16_t*)moonbit_make_string(_M0L10total__lenS69, 0);
      if (_M0L12is__negativeS65) {
        _M0L12digit__startS71 = 1;
      } else {
        _M0L12digit__startS71 = 0;
      }
      moonbit_incref(_M0L6bufferS70);
      #line 239 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
      _M0FPB20int__to__string__dec(_M0L6bufferS70, _M0L3numS66, _M0L12digit__startS71, _M0L10total__lenS69);
      _M0L6bufferS67 = _M0L6bufferS70;
      break;
    }
    
    case 16: {
      int32_t _M0L10digit__lenS72;
      int32_t _M0L6_2atmpS161;
      int32_t _M0L10total__lenS73;
      uint16_t* _M0L6bufferS74;
      int32_t _M0L12digit__startS75;
      #line 243 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
      _M0L10digit__lenS72 = _M0FPB12hex__count32(_M0L3numS66);
      if (_M0L12is__negativeS65) {
        _M0L6_2atmpS161 = 1;
      } else {
        _M0L6_2atmpS161 = 0;
      }
      _M0L10total__lenS73 = _M0L10digit__lenS72 + _M0L6_2atmpS161;
      _M0L6bufferS74 = (uint16_t*)moonbit_make_string(_M0L10total__lenS73, 0);
      if (_M0L12is__negativeS65) {
        _M0L12digit__startS75 = 1;
      } else {
        _M0L12digit__startS75 = 0;
      }
      moonbit_incref(_M0L6bufferS74);
      #line 247 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
      _M0FPB20int__to__string__hex(_M0L6bufferS74, _M0L3numS66, _M0L12digit__startS75, _M0L10total__lenS73);
      _M0L6bufferS67 = _M0L6bufferS74;
      break;
    }
    default: {
      int32_t _M0L10digit__lenS76;
      int32_t _M0L6_2atmpS162;
      int32_t _M0L10total__lenS77;
      uint16_t* _M0L6bufferS78;
      int32_t _M0L12digit__startS79;
      #line 251 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
      _M0L10digit__lenS76
      = _M0FPB14radix__count32(_M0L3numS66, _M0L5radixS63);
      if (_M0L12is__negativeS65) {
        _M0L6_2atmpS162 = 1;
      } else {
        _M0L6_2atmpS162 = 0;
      }
      _M0L10total__lenS77 = _M0L10digit__lenS76 + _M0L6_2atmpS162;
      _M0L6bufferS78 = (uint16_t*)moonbit_make_string(_M0L10total__lenS77, 0);
      if (_M0L12is__negativeS65) {
        _M0L12digit__startS79 = 1;
      } else {
        _M0L12digit__startS79 = 0;
      }
      moonbit_incref(_M0L6bufferS78);
      #line 255 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
      _M0FPB24int__to__string__generic(_M0L6bufferS78, _M0L3numS66, _M0L12digit__startS79, _M0L10total__lenS77, _M0L5radixS63);
      _M0L6bufferS67 = _M0L6bufferS78;
      break;
    }
  }
  if (_M0L12is__negativeS65) {
    _M0L6bufferS67[0] = 45;
  }
  return _M0L6bufferS67;
}

int32_t _M0FPB14radix__count32(uint32_t _M0L5valueS57, int32_t _M0L5radixS59) {
  uint32_t _M0L4baseS58;
  uint32_t _M0L3numS60;
  int32_t _M0L5countS61;
  #line 189 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
  if (_M0L5valueS57 == 0u) {
    return 1;
  }
  _M0L4baseS58 = *(uint32_t*)&_M0L5radixS59;
  _M0L3numS60 = _M0L5valueS57;
  _M0L5countS61 = 0;
  while (1) {
    if (_M0L3numS60 > 0u) {
      uint32_t _M0L6_2atmpS158 = _M0L3numS60 / _M0L4baseS58;
      int32_t _M0L6_2atmpS159 = _M0L5countS61 + 1;
      _M0L3numS60 = _M0L6_2atmpS158;
      _M0L5countS61 = _M0L6_2atmpS159;
      continue;
    } else {
      return _M0L5countS61;
    }
    break;
  }
}

int32_t _M0FPB12hex__count32(uint32_t _M0L5valueS55) {
  #line 177 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
  if (_M0L5valueS55 == 0u) {
    return 1;
  } else {
    int32_t _M0L14leading__zerosS56;
    int32_t _M0L6_2atmpS157;
    int32_t _M0L6_2atmpS156;
    #line 182 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
    _M0L14leading__zerosS56 = moonbit_clz32(_M0L5valueS55);
    _M0L6_2atmpS157 = 31 - _M0L14leading__zerosS56;
    _M0L6_2atmpS156 = _M0L6_2atmpS157 / 4;
    return _M0L6_2atmpS156 + 1;
  }
}

int32_t _M0FPB12dec__count32(uint32_t _M0L5valueS54) {
  #line 143 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
  if (_M0L5valueS54 >= 100000u) {
    if (_M0L5valueS54 >= 10000000u) {
      if (_M0L5valueS54 >= 1000000000u) {
        return 10;
      } else if (_M0L5valueS54 >= 100000000u) {
        return 9;
      } else {
        return 8;
      }
    } else if (_M0L5valueS54 >= 1000000u) {
      return 7;
    } else {
      return 6;
    }
  } else if (_M0L5valueS54 >= 1000u) {
    if (_M0L5valueS54 >= 10000u) {
      return 5;
    } else {
      return 4;
    }
  } else if (_M0L5valueS54 >= 100u) {
    return 3;
  } else if (_M0L5valueS54 >= 10u) {
    return 2;
  } else {
    return 1;
  }
}

int32_t _M0FPB20int__to__string__dec(
  uint16_t* _M0L6bufferS40,
  uint32_t _M0L3numS52,
  int32_t _M0L12digit__startS41,
  int32_t _M0L10total__lenS53
) {
  int32_t _M0L6_2atmpS155;
  uint32_t _M0L3numS30;
  int32_t _M0L6offsetS31;
  #line 88 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
  _M0L6_2atmpS155 = _M0L10total__lenS53 - _M0L12digit__startS41;
  _M0L3numS30 = _M0L3numS52;
  _M0L6offsetS31 = _M0L6_2atmpS155;
  while (1) {
    if (_M0L3numS30 >= 10000u) {
      uint32_t _M0L1tS32 = _M0L3numS30 / 10000u;
      uint32_t _M0L6_2atmpS132 = _M0L3numS30 % 10000u;
      int32_t _M0L1rS33 = *(int32_t*)&_M0L6_2atmpS132;
      int32_t _M0L2d1S34 = _M0L1rS33 / 100;
      int32_t _M0L2d2S35 = _M0L1rS33 % 100;
      int32_t _M0L6_2atmpS131 = _M0L2d1S34 / 10;
      int32_t _M0L6_2atmpS130 = 48 + _M0L6_2atmpS131;
      int32_t _M0L6d1__hiS36 = (uint16_t)_M0L6_2atmpS130;
      int32_t _M0L6_2atmpS129 = _M0L2d1S34 % 10;
      int32_t _M0L6_2atmpS128 = 48 + _M0L6_2atmpS129;
      int32_t _M0L6d1__loS37 = (uint16_t)_M0L6_2atmpS128;
      int32_t _M0L6_2atmpS127 = _M0L2d2S35 / 10;
      int32_t _M0L6_2atmpS126 = 48 + _M0L6_2atmpS127;
      int32_t _M0L6d2__hiS38 = (uint16_t)_M0L6_2atmpS126;
      int32_t _M0L6_2atmpS125 = _M0L2d2S35 % 10;
      int32_t _M0L6_2atmpS124 = 48 + _M0L6_2atmpS125;
      int32_t _M0L6d2__loS39 = (uint16_t)_M0L6_2atmpS124;
      int32_t _M0L6_2atmpS116 = _M0L12digit__startS41 + _M0L6offsetS31;
      int32_t _M0L6_2atmpS115 = _M0L6_2atmpS116 - 4;
      int32_t _M0L6_2atmpS118;
      int32_t _M0L6_2atmpS117;
      int32_t _M0L6_2atmpS120;
      int32_t _M0L6_2atmpS119;
      int32_t _M0L6_2atmpS122;
      int32_t _M0L6_2atmpS121;
      int32_t _M0L6_2atmpS123;
      _M0L6bufferS40[_M0L6_2atmpS115] = _M0L6d1__hiS36;
      _M0L6_2atmpS118 = _M0L12digit__startS41 + _M0L6offsetS31;
      _M0L6_2atmpS117 = _M0L6_2atmpS118 - 3;
      _M0L6bufferS40[_M0L6_2atmpS117] = _M0L6d1__loS37;
      _M0L6_2atmpS120 = _M0L12digit__startS41 + _M0L6offsetS31;
      _M0L6_2atmpS119 = _M0L6_2atmpS120 - 2;
      _M0L6bufferS40[_M0L6_2atmpS119] = _M0L6d2__hiS38;
      _M0L6_2atmpS122 = _M0L12digit__startS41 + _M0L6offsetS31;
      _M0L6_2atmpS121 = _M0L6_2atmpS122 - 1;
      _M0L6bufferS40[_M0L6_2atmpS121] = _M0L6d2__loS39;
      _M0L6_2atmpS123 = _M0L6offsetS31 - 4;
      _M0L3numS30 = _M0L1tS32;
      _M0L6offsetS31 = _M0L6_2atmpS123;
      continue;
    } else {
      int32_t _M0L6_2atmpS154 = *(int32_t*)&_M0L3numS30;
      int32_t _M0L9remainingS43 = _M0L6_2atmpS154;
      int32_t _M0L6offsetS44 = _M0L6offsetS31;
      while (1) {
        if (_M0L9remainingS43 >= 100) {
          int32_t _M0L1tS45 = _M0L9remainingS43 / 100;
          int32_t _M0L1dS46 = _M0L9remainingS43 % 100;
          int32_t _M0L6_2atmpS141 = _M0L1dS46 / 10;
          int32_t _M0L6_2atmpS140 = 48 + _M0L6_2atmpS141;
          int32_t _M0L5d__hiS47 = (uint16_t)_M0L6_2atmpS140;
          int32_t _M0L6_2atmpS139 = _M0L1dS46 % 10;
          int32_t _M0L6_2atmpS138 = 48 + _M0L6_2atmpS139;
          int32_t _M0L5d__loS48 = (uint16_t)_M0L6_2atmpS138;
          int32_t _M0L6_2atmpS134 = _M0L12digit__startS41 + _M0L6offsetS44;
          int32_t _M0L6_2atmpS133 = _M0L6_2atmpS134 - 2;
          int32_t _M0L6_2atmpS136;
          int32_t _M0L6_2atmpS135;
          int32_t _M0L6_2atmpS137;
          _M0L6bufferS40[_M0L6_2atmpS133] = _M0L5d__hiS47;
          _M0L6_2atmpS136 = _M0L12digit__startS41 + _M0L6offsetS44;
          _M0L6_2atmpS135 = _M0L6_2atmpS136 - 1;
          _M0L6bufferS40[_M0L6_2atmpS135] = _M0L5d__loS48;
          _M0L6_2atmpS137 = _M0L6offsetS44 - 2;
          _M0L9remainingS43 = _M0L1tS45;
          _M0L6offsetS44 = _M0L6_2atmpS137;
          continue;
        } else if (_M0L9remainingS43 >= 10) {
          int32_t _M0L6_2atmpS149 = _M0L9remainingS43 / 10;
          int32_t _M0L6_2atmpS148 = 48 + _M0L6_2atmpS149;
          int32_t _M0L5d__hiS50 = (uint16_t)_M0L6_2atmpS148;
          int32_t _M0L6_2atmpS147 = _M0L9remainingS43 % 10;
          int32_t _M0L6_2atmpS146 = 48 + _M0L6_2atmpS147;
          int32_t _M0L5d__loS51 = (uint16_t)_M0L6_2atmpS146;
          int32_t _M0L6_2atmpS143 = _M0L12digit__startS41 + _M0L6offsetS44;
          int32_t _M0L6_2atmpS142 = _M0L6_2atmpS143 - 2;
          int32_t _M0L6_2atmpS145;
          int32_t _M0L6_2atmpS144;
          _M0L6bufferS40[_M0L6_2atmpS142] = _M0L5d__hiS50;
          _M0L6_2atmpS145 = _M0L12digit__startS41 + _M0L6offsetS44;
          _M0L6_2atmpS144 = _M0L6_2atmpS145 - 1;
          _M0L6bufferS40[_M0L6_2atmpS144] = _M0L5d__loS51;
          moonbit_decref(_M0L6bufferS40);
        } else {
          int32_t _M0L6_2atmpS153 = _M0L12digit__startS41 + _M0L6offsetS44;
          int32_t _M0L6_2atmpS150 = _M0L6_2atmpS153 - 1;
          int32_t _M0L6_2atmpS152 = 48 + _M0L9remainingS43;
          int32_t _M0L6_2atmpS151 = (uint16_t)_M0L6_2atmpS152;
          _M0L6bufferS40[_M0L6_2atmpS150] = _M0L6_2atmpS151;
          moonbit_decref(_M0L6bufferS40);
        }
        break;
      }
    }
    break;
  }
  return 0;
}

int32_t _M0FPB24int__to__string__generic(
  uint16_t* _M0L6bufferS20,
  uint32_t _M0L3numS24,
  int32_t _M0L12digit__startS21,
  int32_t _M0L10total__lenS23,
  int32_t _M0L5radixS14
) {
  uint32_t _M0L4baseS13;
  int32_t _M0L6_2atmpS100;
  int32_t _M0L6_2atmpS99;
  #line 57 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
  _M0L4baseS13 = *(uint32_t*)&_M0L5radixS14;
  _M0L6_2atmpS100 = _M0L5radixS14 - 1;
  _M0L6_2atmpS99 = _M0L5radixS14 & _M0L6_2atmpS100;
  if (_M0L6_2atmpS99 == 0) {
    int32_t _M0L5shiftS15;
    uint32_t _M0L4maskS16;
    int32_t _M0L6_2atmpS107;
    int32_t _M0L6offsetS17;
    uint32_t _M0L1nS18;
    #line 68 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
    _M0L5shiftS15 = moonbit_ctz32(_M0L5radixS14);
    _M0L4maskS16 = _M0L4baseS13 - 1u;
    _M0L6_2atmpS107 = _M0L10total__lenS23 - _M0L12digit__startS21;
    _M0L6offsetS17 = _M0L6_2atmpS107;
    _M0L1nS18 = _M0L3numS24;
    while (1) {
      if (_M0L1nS18 > 0u) {
        uint32_t _M0L6_2atmpS106 = _M0L1nS18 & _M0L4maskS16;
        int32_t _M0L5digitS19 = *(int32_t*)&_M0L6_2atmpS106;
        int32_t _M0L6_2atmpS103 = _M0L12digit__startS21 + _M0L6offsetS17;
        int32_t _M0L6_2atmpS101 = _M0L6_2atmpS103 - 1;
        int32_t _M0L6_2atmpS102 =
          ((moonbit_string_t)moonbit_string_literal_2.data)[_M0L5digitS19];
        int32_t _M0L6_2atmpS104;
        uint32_t _M0L6_2atmpS105;
        _M0L6bufferS20[_M0L6_2atmpS101] = _M0L6_2atmpS102;
        _M0L6_2atmpS104 = _M0L6offsetS17 - 1;
        _M0L6_2atmpS105 = _M0L1nS18 >> (_M0L5shiftS15 & 31);
        _M0L6offsetS17 = _M0L6_2atmpS104;
        _M0L1nS18 = _M0L6_2atmpS105;
        continue;
      } else {
        moonbit_decref(_M0L6bufferS20);
      }
      break;
    }
  } else {
    int32_t _M0L6_2atmpS114 = _M0L10total__lenS23 - _M0L12digit__startS21;
    int32_t _M0L6offsetS25 = _M0L6_2atmpS114;
    uint32_t _M0L1nS26 = _M0L3numS24;
    while (1) {
      if (_M0L1nS26 > 0u) {
        uint32_t _M0L1qS27 = _M0L1nS26 / _M0L4baseS13;
        uint32_t _M0L6_2atmpS113 = _M0L1qS27 * _M0L4baseS13;
        uint32_t _M0L6_2atmpS112 = _M0L1nS26 - _M0L6_2atmpS113;
        int32_t _M0L5digitS28 = *(int32_t*)&_M0L6_2atmpS112;
        int32_t _M0L6_2atmpS110 = _M0L12digit__startS21 + _M0L6offsetS25;
        int32_t _M0L6_2atmpS108 = _M0L6_2atmpS110 - 1;
        int32_t _M0L6_2atmpS109 =
          ((moonbit_string_t)moonbit_string_literal_2.data)[_M0L5digitS28];
        int32_t _M0L6_2atmpS111;
        _M0L6bufferS20[_M0L6_2atmpS108] = _M0L6_2atmpS109;
        _M0L6_2atmpS111 = _M0L6offsetS25 - 1;
        _M0L6offsetS25 = _M0L6_2atmpS111;
        _M0L1nS26 = _M0L1qS27;
        continue;
      } else {
        moonbit_decref(_M0L6bufferS20);
      }
      break;
    }
  }
  return 0;
}

int32_t _M0FPB20int__to__string__hex(
  uint16_t* _M0L6bufferS7,
  uint32_t _M0L3numS12,
  int32_t _M0L12digit__startS8,
  int32_t _M0L10total__lenS11
) {
  int32_t _M0L6_2atmpS98;
  int32_t _M0L6offsetS2;
  uint32_t _M0L1nS3;
  #line 29 "/home/kodehu03/.moon/lib/core/builtin/to_string.mbt"
  _M0L6_2atmpS98 = _M0L10total__lenS11 - _M0L12digit__startS8;
  _M0L6offsetS2 = _M0L6_2atmpS98;
  _M0L1nS3 = _M0L3numS12;
  while (1) {
    if (_M0L6offsetS2 >= 2) {
      uint32_t _M0L6_2atmpS95 = _M0L1nS3 & 255u;
      int32_t _M0L9byte__valS4 = *(int32_t*)&_M0L6_2atmpS95;
      int32_t _M0L2hiS5 = _M0L9byte__valS4 / 16;
      int32_t _M0L2loS6 = _M0L9byte__valS4 % 16;
      int32_t _M0L6_2atmpS89 = _M0L12digit__startS8 + _M0L6offsetS2;
      int32_t _M0L6_2atmpS87 = _M0L6_2atmpS89 - 2;
      int32_t _M0L6_2atmpS88 =
        ((moonbit_string_t)moonbit_string_literal_2.data)[_M0L2hiS5];
      int32_t _M0L6_2atmpS92;
      int32_t _M0L6_2atmpS90;
      int32_t _M0L6_2atmpS91;
      int32_t _M0L6_2atmpS93;
      uint32_t _M0L6_2atmpS94;
      _M0L6bufferS7[_M0L6_2atmpS87] = _M0L6_2atmpS88;
      _M0L6_2atmpS92 = _M0L12digit__startS8 + _M0L6offsetS2;
      _M0L6_2atmpS90 = _M0L6_2atmpS92 - 1;
      _M0L6_2atmpS91
      = ((moonbit_string_t)moonbit_string_literal_2.data)[
        _M0L2loS6
      ];
      _M0L6bufferS7[_M0L6_2atmpS90] = _M0L6_2atmpS91;
      _M0L6_2atmpS93 = _M0L6offsetS2 - 2;
      _M0L6_2atmpS94 = _M0L1nS3 >> 8;
      _M0L6offsetS2 = _M0L6_2atmpS93;
      _M0L1nS3 = _M0L6_2atmpS94;
      continue;
    } else if (_M0L6offsetS2 == 1) {
      uint32_t _M0L6_2atmpS97 = _M0L1nS3 & 15u;
      int32_t _M0L6nibbleS10 = *(int32_t*)&_M0L6_2atmpS97;
      int32_t _M0L6_2atmpS96 =
        ((moonbit_string_t)moonbit_string_literal_2.data)[_M0L6nibbleS10];
      _M0L6bufferS7[_M0L12digit__startS8] = _M0L6_2atmpS96;
      moonbit_decref(_M0L6bufferS7);
    } else {
      moonbit_decref(_M0L6bufferS7);
    }
    break;
  }
  return 0;
}

int32_t _M0FPC15abort5abortGuE(moonbit_string_t _M0L3msgS1) {
  #line 47 "/home/kodehu03/.moon/lib/core/abort/abort.mbt"
  #line 49 "/home/kodehu03/.moon/lib/core/abort/abort.mbt"
  moonbit_println(_M0L3msgS1);
  moonbit_decref(_M0L3msgS1);
  #line 50 "/home/kodehu03/.moon/lib/core/abort/abort.mbt"
  moonbit_panic();
  return 0;
}

void moonbit_init() {
  
}

int moonbit_entry(int argc, char** argv) {
  int32_t _M0L6resultS84;
  moonbit_string_t _M0L6_2atmpS86;
  moonbit_string_t _M0L6_2atmpS85;
  moonbit_runtime_init(argc, argv);
  moonbit_init();
  #line 6 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  _M0FPB7printlnGsE((moonbit_string_t)moonbit_string_literal_3.data);
  #line 7 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  _M0FPB7printlnGsE((moonbit_string_t)moonbit_string_literal_4.data);
  #line 8 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  _M0FPB7printlnGsE((moonbit_string_t)moonbit_string_literal_5.data);
  #line 9 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  _M0FPB7printlnGsE((moonbit_string_t)moonbit_string_literal_6.data);
  #line 10 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  _M0FPB7printlnGsE((moonbit_string_t)moonbit_string_literal_7.data);
  #line 12 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  _M0FPB7printlnGsE((moonbit_string_t)moonbit_string_literal_8.data);
  #line 13 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  _M0L6resultS84 = _M0FP47khy__os6kernel3lib11khy__kernel3fib(20);
  #line 14 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  _M0L6_2atmpS86 = _M0IPC13int3IntPB4Show10to__string(_M0L6resultS84);
  #line 14 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  _M0L6_2atmpS85
  = moonbit_add_string((moonbit_string_t)moonbit_string_literal_9.data, _M0L6_2atmpS86);
  moonbit_decref(_M0L6_2atmpS86);
  #line 14 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  _M0FPB7printlnGsE(_M0L6_2atmpS85);
  #line 15 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  _M0FPB7printlnGsE((moonbit_string_t)moonbit_string_literal_10.data);
  #line 16 "/home/kodehu03/Khy-OS/kernel/moonbit/lib/khy_kernel/main.mbt"
  _M0FPB7printlnGsE((moonbit_string_t)moonbit_string_literal_11.data);
  return 0;
}