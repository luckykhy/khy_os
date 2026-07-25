/*
 * Copyright 2026 International Digital Economy Academy
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef moonbit_fundamental_h_INCLUDED
#define moonbit_fundamental_h_INCLUDED
typedef __SIZE_TYPE__ size_t;
typedef __UINTPTR_TYPE__ uintptr_t;

typedef __INT32_TYPE__ int32_t;
typedef unsigned __INT32_TYPE__ uint32_t;

typedef __INT64_TYPE__ int64_t;
typedef unsigned __INT64_TYPE__ uint64_t;

typedef short int16_t; 
typedef unsigned short uint16_t; 
typedef unsigned char uint8_t;

#define INFINITY (1.0/0.0)
#define NAN (0.0/0.0)
#define offsetof(type, field) ((uintptr_t)(&(((type*)0)->field)))
#endif
