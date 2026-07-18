'use strict';

/**
 * Jest global setup — disable the RTK token-saving layer by default.
 *
 * RTK (`KHY_RTK_MODE`, default ON in production) rewrites shell commands and
 * grep(content) into `rtk` equivalents *whenever an `rtk` binary is resolvable*
 * (PATH or ~/.khy/bin). Many existing suites assert the exact NATIVE command
 * shape (Git Bash POSIX passthrough, Windows cmd.exe `/d /s /c`, rg argv, …),
 * which is a concern orthogonal to RTK routing.
 *
 * In CI rtk is absent, so the seams are inert and those assertions hold. But on
 * a developer machine that has rtk installed they would spuriously fail. Pinning
 * the jest suite to rtk-off makes command-shape tests deterministic regardless
 * of the ambient binary. The RTK logic itself is covered deterministically by
 * tests/rtkMode.test.js (node:test, injected spawn) plus manual integration
 * smoke. A suite that genuinely wants rtk ON can set `process.env.KHY_RTK_MODE`
 * inside the test body (runs after this setup), overriding the default.
 *
 * Honors an explicit opt-in: `KHY_RTK_MODE=on npx jest` leaves it untouched.
 */
if (process.env.KHY_RTK_MODE === undefined) {
  process.env.KHY_RTK_MODE = 'off';
}
