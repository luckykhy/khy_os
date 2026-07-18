# KHY OS Kernel Makefile

# Toolchain. Defaults force the known-good GNU/Linux binaries (do NOT use `?=`:
# make pre-defines CC=cc as a built-in, so `?=` would silently leave CC=cc and
# pick up clang on macOS/BSD). Override per-build from the command line, which has
# the highest precedence and always wins over these `=` assignments — e.g.
# `make CC=x86_64-elf-gcc LD=ld.lld GRUB_MKRESCUE=grub2-mkrescue iso`. `khy os
# build` forwards KHY_CC / KHY_NASM / KHY_LD / KHY_GRUB_MKRESCUE as exactly these
# command-line variables, so the Makefile itself never needs editing per host.
ASM           = nasm
CC            = gcc
LD            = ld
GRUB_MKRESCUE = grub-mkrescue

# Directories
BOOT_DIR = boot
SRC_DIR  = src
BUILD    = build
MOONBIT_DIR = moonbit

# Detect GCC version (kept for diagnostics)
GCC_VER := $(shell $(CC) -dumpversion)

# GCC's own freestanding header dir (stddef.h, stdint.h, stdarg.h, …). Resolve it
# portably from the compiler itself instead of hardcoding a Debian path: on
# Debian/Ubuntu `-print-file-name=include` yields the very same
# /usr/lib/gcc/x86_64-linux-gnu/<ver>/include the path was hardcoded to, while on
# Arch/Fedora/macOS/MSYS2/cross toolchains it resolves to their layout. Override
# GCC_INCLUDE to force a specific path.
GCC_INCLUDE ?= $(shell $(CC) -print-file-name=include)

# Optional version stamp from a single source of truth. When a distribution
# build passes KHY_VERSION (e.g. `make KHY_VERSION=0.1.108 iso`), it is injected
# as -DKHY_OS_VERSION so the boot banner matches the release; left empty, the
# kernel falls back to its own #define default and `make` stays self-contained.
KHY_VERSION =
ifneq ($(strip $(KHY_VERSION)),)
VERSION_DEFINE = -DKHY_OS_VERSION='"$(KHY_VERSION)"'
else
VERSION_DEFINE =
endif

# Host-injected extra compiler flags, appended last so they can steer codegen the
# Makefile cannot know about per host. Empty by default (GNU/Linux gcc needs none).
# `khy os build`'s native-LLVM backend passes EXTRA_CFLAGS=--target=x86_64-elf here:
# llvm-mingw's clang otherwise defaults to a Windows target (COFF objects + _WIN32
# defined), but this kernel is ELF (nasm -f elf64 + the GNU linker.ld) and must not
# be a Windows build. Forcing the bare-metal x86_64 ELF target makes clang emit ELF
# objects that link with the nasm ones under ld.lld AND leaves _WIN32 undefined, so
# the build matches the known-good Linux gcc path. Override per-build from the
# command line (highest make precedence), exactly like CC/LD above.
EXTRA_CFLAGS =

# Compiler flags — freestanding x86_64 kernel
CFLAGS   = -ffreestanding -nostdlib -nostdinc -fno-builtin \
           -fno-stack-protector -mno-red-zone -mcmodel=kernel \
           -fno-pic -fno-pie \
           -Wall -Wextra -O2 -g \
           $(VERSION_DEFINE) \
           -isystem $(GCC_INCLUDE) \
           $(EXTRA_CFLAGS)

# MoonBit generated C flags — same as kernel but with MOONBIT_NATIVE_NO_SYS_HEADER
MOONBIT_CFLAGS = $(CFLAGS) -DMOONBIT_NATIVE_NO_SYS_HEADER -Wno-unused-function -Wno-unused-variable

ASMFLAGS = -f elf64
LDFLAGS  = -n -T linker.ld -nostdlib

# Source files
ASM_SRC  = $(BOOT_DIR)/boot.asm $(BOOT_DIR)/long_mode.asm $(BOOT_DIR)/isr.asm $(BOOT_DIR)/context_switch.asm $(BOOT_DIR)/usermode.asm
C_SRC    = $(wildcard $(SRC_DIR)/*.c)

# MoonBit source mode. Default (empty) = regenerate the C via the `moon` toolchain,
# exactly as before. MOONBIT_PREBUILT=1 = consume the committed generated C plus the
# vendored runtime/headers under vendor/moonbit, and NEVER invoke `moon` — this is what
# lets the native Windows build (clang/lld/nasm + Limine) work without a MoonBit install.
# See kernel/vendor/moonbit/PROVENANCE.md.
MOONBIT_PREBUILT ?=
ifeq ($(strip $(MOONBIT_PREBUILT)),)
  # Toolchain mode: paths into ~/.moon and the `moonbit-build` phony regenerates gen.c.
  MOONBIT_INCLUDE = $(HOME)/.moon/include
  MOONBIT_RUNTIME = $(HOME)/.moon/lib/runtime.c
  MOONBIT_GEN_DIR = $(MOONBIT_DIR)/_build/native/debug/build/lib/khy_kernel
  MOONBIT_GEN_C   = $(BUILD)/moonbit_gen.c
  MOONBIT_GEN_DEP = moonbit-build
else
  # Prebuilt mode: vendored, committed files. MOONBIT_GEN_DEP is a real file prereq, so
  # make never reaches the `moonbit-build` recipe and `moon` is never spawned.
  MOONBIT_VENDOR  = vendor/moonbit
  MOONBIT_INCLUDE = $(MOONBIT_VENDOR)/include
  MOONBIT_RUNTIME = $(MOONBIT_VENDOR)/runtime.c
  MOONBIT_GEN_C   = $(MOONBIT_VENDOR)/moonbit_gen.c
  MOONBIT_GEN_DEP = $(MOONBIT_GEN_C)
endif

# Object files
ASM_OBJ  = $(patsubst $(BOOT_DIR)/%.asm,$(BUILD)/%.o,$(ASM_SRC))
C_OBJ    = $(patsubst $(SRC_DIR)/%.c,$(BUILD)/%.o,$(C_SRC))
MOONBIT_OBJ = $(BUILD)/moonbit_gen.o $(BUILD)/moonbit_runtime.o
ALL_OBJ  = $(ASM_OBJ) $(C_OBJ) $(MOONBIT_OBJ)

# Output (kernel ISO is named -kernel to distinguish from the Alpine-based dist ISO)
KERNEL   = $(BUILD)/khy-os.bin
ISO      = $(BUILD)/khy-os-kernel.iso

# Default target
.PHONY: all clean run run-serial iso iso-limine moonbit-build userland run-agent

all: $(ISO)

# Step 1: Build MoonBit project to generate .c file
moonbit-build:
	@echo "[MOONBIT] Building MoonBit module..."
	cd $(MOONBIT_DIR) && moon build --target native 2>&1 | grep -v "Cannot find TCC"
	@echo "[MOONBIT] Patching generated C: rename main() -> moonbit_entry()"
	@sed 's/^int main(int argc, char\*\* argv)/int moonbit_entry(int argc, char** argv)/' \
		$(MOONBIT_GEN_DIR)/khy_kernel.c > $(MOONBIT_GEN_C)
	@echo "[MOONBIT] Generated C ready: $(MOONBIT_GEN_C)"

# Step 2: Compile MoonBit generated C. The prereq is MOONBIT_GEN_DEP: in toolchain mode
# that is the `moonbit-build` phony (regenerates gen.c via `moon`); in prebuilt mode it is
# the committed vendor/moonbit/moonbit_gen.c, so `moon` is never invoked.
$(BUILD)/moonbit_gen.o: $(MOONBIT_GEN_DEP) | $(BUILD)
	$(CC) $(MOONBIT_CFLAGS) -I$(MOONBIT_INCLUDE) -I$(SRC_DIR) -c $(MOONBIT_GEN_C) -o $@

# Step 3: Compile MoonBit runtime
$(BUILD)/moonbit_runtime.o: $(MOONBIT_RUNTIME) | $(BUILD)
	$(CC) $(MOONBIT_CFLAGS) -I$(MOONBIT_INCLUDE) -I$(SRC_DIR) -c $< -o $@

# Assemble .asm files
$(BUILD)/%.o: $(BOOT_DIR)/%.asm | $(BUILD)
	$(ASM) $(ASMFLAGS) $< -o $@

# Compile .c files
$(BUILD)/%.o: $(SRC_DIR)/%.c | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

# ramfs.c embeds the generated Ring 3 program blobs; without this dependency a
# `make userland` regen would not trigger a ramfs.o rebuild (the pattern rule
# tracks only the .c), silently linking a stale program. Cost a debug cycle once.
$(BUILD)/ramfs.o: $(SRC_DIR)/user_init_blob.h $(SRC_DIR)/user_filetest_blob.h $(SRC_DIR)/user_argv_blob.h $(SRC_DIR)/user_badptr_blob.h $(SRC_DIR)/user_forktest_blob.h $(SRC_DIR)/user_exectest_blob.h $(SRC_DIR)/user_forkwait_blob.h $(SRC_DIR)/user_fault_blob.h $(SRC_DIR)/user_stackgrow_blob.h $(SRC_DIR)/user_cowtest_blob.h $(SRC_DIR)/user_proctest_blob.h $(SRC_DIR)/user_pipetest_blob.h $(SRC_DIR)/user_stdiotest_blob.h $(SRC_DIR)/user_sigtest_blob.h $(SRC_DIR)/user_pipesrc_blob.h $(SRC_DIR)/user_pipedst_blob.h $(SRC_DIR)/user_readtest_blob.h $(SRC_DIR)/user_siginttest_blob.h $(SRC_DIR)/user_spintest_blob.h $(SRC_DIR)/user_spinbare_blob.h $(SRC_DIR)/user_usertest_blob.h $(SRC_DIR)/user_cwdtest_blob.h $(SRC_DIR)/user_rmtest_blob.h $(SRC_DIR)/user_linktest_blob.h $(SRC_DIR)/user_mmaptest_blob.h $(SRC_DIR)/user_vmtest_blob.h $(SRC_DIR)/user_stattest_blob.h $(SRC_DIR)/user_dirtest_blob.h $(SRC_DIR)/user_lseektest_blob.h $(SRC_DIR)/user_trunctest_blob.h $(SRC_DIR)/user_renametest_blob.h $(SRC_DIR)/user_dirfdtest_blob.h $(SRC_DIR)/user_dup2test_blob.h $(SRC_DIR)/user_timetest_blob.h $(SRC_DIR)/user_mtimetest_blob.h $(SRC_DIR)/user_atimetest_blob.h $(SRC_DIR)/user_ptimetest_blob.h

# framebuffer.c embeds the generated CJK font header; like ramfs.o above the
# pattern rule tracks only the .c, so regenerating cjk_font16.h (e.g. adding a
# character) would otherwise leave a stale font compiled into the kernel.
$(BUILD)/framebuffer.o: $(SRC_DIR)/cjk_font16.h

# Link kernel binary
$(KERNEL): $(ALL_OBJ)
	$(LD) $(LDFLAGS) -o $@ $^

# Build ISO with GRUB
$(ISO): $(KERNEL)
	@mkdir -p $(BUILD)/isofiles/boot/grub
	cp $(KERNEL) $(BUILD)/isofiles/boot/khy-os.bin
	cp iso/boot/grub/grub.cfg $(BUILD)/isofiles/boot/grub/grub.cfg
	$(GRUB_MKRESCUE) -o $(ISO) $(BUILD)/isofiles 2>/dev/null

# Build ISO with Limine — grub-free path for hosts without grub-mkrescue (notably
# native Windows). Limine boots the same Multiboot2 kernel unchanged. LIMINE_DIR holds
# the provisioned Limine binary files; LIMINE is the `limine` host tool; XORRISO is the
# ISO author. `khy os build` forwards these as LIMINE_DIR / LIMINE / XORRISO make vars.
LIMINE_DIR ?= vendor/limine
LIMINE     ?= limine
XORRISO    ?= xorriso
iso-limine: $(KERNEL)
	@mkdir -p $(BUILD)/isofiles/boot/limine
	cp $(KERNEL) $(BUILD)/isofiles/boot/khy-os.bin
	cp iso/boot/limine/limine.conf $(BUILD)/isofiles/boot/limine/limine.conf
	cp $(LIMINE_DIR)/limine-bios.sys $(LIMINE_DIR)/limine-bios-cd.bin $(LIMINE_DIR)/limine-uefi-cd.bin $(BUILD)/isofiles/boot/limine/
	$(XORRISO) -as mkisofs -b boot/limine/limine-bios-cd.bin -no-emul-boot \
	  -boot-load-size 4 -boot-info-table --efi-boot boot/limine/limine-uefi-cd.bin \
	  -efi-boot-part --efi-boot-image --protective-msdos-label $(BUILD)/isofiles -o $(ISO)
	$(LIMINE) bios-install $(ISO)

# Create build directory
$(BUILD):
	mkdir -p $(BUILD)

# Run in QEMU with serial output to terminal
run: $(ISO)
	qemu-system-x86_64 -cdrom $(ISO) -serial stdio -display none -no-reboot

# Run in QEMU with VGA display
run-vga: $(ISO)
	qemu-system-x86_64 -cdrom $(ISO) -serial stdio

# Run with both serial and monitor
run-debug: $(ISO)
	qemu-system-x86_64 -cdrom $(ISO) -serial stdio -monitor telnet:127.0.0.1:1234,server,nowait -d int -no-reboot

# Run with a persistent 16MB ATA disk on the primary master (creates it once).
# Try: diskwrite 100 hello / diskread 100, then re-run to see it survive reboot.
DISK ?= $(BUILD)/khy-disk.img
run-disk: $(ISO)
	@test -f $(DISK) || qemu-img create -f raw $(DISK) 16M
	qemu-system-x86_64 -cdrom $(ISO) -hda $(DISK) -serial stdio -display none -no-reboot

# Run with the Agent ⇄ OS bridge channel exposed. COM1 (first -serial) stays the
# human TTY on stdio; COM2 (second -serial) is the agent channel on a unix
# socket. A host agent — or the A1 echo test — connects to $(AGENT_SOCK).
# QEMU assigns serial ports in declaration order, so order matters here.
AGENT_SOCK ?= /tmp/khy-agent.sock
run-agent: $(ISO)
	@rm -f $(AGENT_SOCK)
	qemu-system-x86_64 -cdrom $(ISO) \
	  -serial stdio \
	  -serial unix:$(AGENT_SOCK),server,nowait \
	  -display none -no-reboot

# Regenerate the embedded Ring 3 programs (src/user_<name>_blob.h) from their
# sources. NOT part of the default build — the generated headers are checked in
# so a plain `make` never depends on the userland toolchain. Run this only after
# editing a userland/*.asm program.
USERLAND_PROGS = init filetest argv badptr forktest exectest forkwait fault stackgrow cowtest proctest pipetest stdiotest sigtest pipesrc pipedst readtest siginttest spintest spinbare usertest cwdtest rmtest linktest mmaptest vmtest stattest dirtest lseektest trunctest renametest dirfdtest dup2test timetest mtimetest atimetest ptimetest
userland:
	@for p in $(USERLAND_PROGS); do \
	  $(ASM) -f elf64 userland/$$p.asm -o userland/$$p.o; \
	  $(LD) -static -nostdlib -n -Ttext=0x400000 -e _start userland/$$p.o -o userland/$$p.elf; \
	  guard=USER_`echo $$p | tr a-z A-Z`_BLOB_H; \
	  { \
	    echo "/* user_$${p}_blob.h — GENERATED, do not edit by hand."; \
	    echo " *"; \
	    echo " * Embedded Ring 3 program written to /bin/$$p.elf by ramfs_init()."; \
	    echo " * Source: userland/$$p.asm. Regenerate with: make userland"; \
	    echo " */"; \
	    echo "#ifndef $$guard"; \
	    echo "#define $$guard"; \
	    echo ""; \
	    (cd userland && xxd -i $$p.elf) \
	      | sed -e "s/unsigned char $${p}_elf\[\]/static const unsigned char user_$${p}_elf[]/" \
	            -e "s/unsigned int $${p}_elf_len/static const unsigned int user_$${p}_elf_len/"; \
	    echo ""; \
	    echo "#endif /* $$guard */"; \
	  } > $(SRC_DIR)/user_$${p}_blob.h; \
	  echo "[userland] regenerated $(SRC_DIR)/user_$${p}_blob.h"; \
	done

# Build ISO only
iso: $(ISO)

# Clean build artifacts (including MoonBit build)
clean:
	rm -rf $(BUILD)
	cd $(MOONBIT_DIR) && moon clean 2>/dev/null || true
