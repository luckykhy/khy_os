'use strict';

/**
 * khy-hello test-fixture plugin.
 *
 * Registers the `/hello.greet` command. The greeting counter is persisted
 * through the per-plugin KV storage so the two sequential handler invocations
 * in the plugin-system integration test observe `#1` then `#2` (storage
 * isolation proof). Counter is scoped per mock context so the test's output
 * capture works; storage is namespaced to this plugin by the host.
 */

module.exports = {
  activate(ctx) {
    ctx.commands.register({
      name: 'greet',
      description: 'Greet someone and count greetings',
      async handler(raw, cmdCtx = {}) {
        const args = raw && raw.positional ? raw.positional : [];
        const name = (args[0] || 'world').toString();
        const count = (Number(await ctx.storage.get('greetCount')) || 0) + 1;
        await ctx.storage.set('greetCount', count);
        const text = `Hello, ${name}! (#${count})`;
        const sink = cmdCtx;
        if (sink && typeof sink.print === 'function') sink.print(text);
        else if (sink && typeof sink.printStyled === 'function') sink.printStyled(text);
        return { success: true, text };
      },
    });
  },
};
