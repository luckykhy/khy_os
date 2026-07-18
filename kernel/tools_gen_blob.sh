#!/usr/bin/env bash
# One-off blob generator for a single userland program, mirroring the Makefile's
# `userland` recipe but without regenerating the other checked-in blobs. Usage:
#   tools_gen_blob.sh <name>
set -euo pipefail
cd "$(dirname "$0")"
p="$1"
guard="USER_$(echo "$p" | tr 'a-z' 'A-Z')_BLOB_H"
nasm -f elf64 "userland/$p.asm" -o "userland/$p.o"
ld -static -nostdlib -n -Ttext=0x400000 -e _start "userland/$p.o" -o "userland/$p.elf"
{
  echo "/* user_${p}_blob.h — GENERATED, do not edit by hand."
  echo " *"
  echo " * Embedded Ring 3 program written to /bin/${p}.elf by ramfs_init()."
  echo " * Source: userland/${p}.asm. Regenerate with: make userland"
  echo " */"
  echo "#ifndef $guard"
  echo "#define $guard"
  echo ""
  ( cd userland && xxd -i "${p}.elf" ) \
    | sed -e "s/unsigned char ${p}_elf\[\]/static const unsigned char user_${p}_elf[]/" \
          -e "s/unsigned int ${p}_elf_len/static const unsigned int user_${p}_elf_len/"
  echo ""
  echo "#endif /* $guard */"
} > "src/user_${p}_blob.h"
rm -f "userland/$p.o"
echo "[OK] generated src/user_${p}_blob.h"
