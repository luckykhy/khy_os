# khyquant/indicators

MoonBit technical indicator package (pure compute).

## Offline test run (no network)

From repository root:

```bash
scripts/moonbit/run-wasm-indicators-tests-offline.sh
```

Default local tar paths used by the script:

- `/home/kodehu03/Downloads/moonbit-linux-x86_64.tar(1).gz`
- `/home/kodehu03/Downloads/moonbit-wasm.tar.gz`

You can override them:

```bash
MOONBIT_LINUX_TAR=/abs/path/moonbit-linux.tar.gz \
MOONBIT_WASM_TAR=/abs/path/moonbit-wasm.tar.gz \
scripts/moonbit/run-wasm-indicators-tests-offline.sh
```

By default, the script enforces warning-free checks (`--deny-warn`).
If you need temporary non-strict mode for diagnosis:

```bash
MOON_DENY_WARN=false scripts/moonbit/run-wasm-indicators-tests-offline.sh
```
