import {
  getBranchContext,
  runWithBranchBypass,
  runWithBranchStore,
  setBranchContext,
} from './branch-context';

/**
 * Overlapping branch bypasses.
 *
 * The store is shared by everything a request awaits, so two bypasses WILL
 * overlap. While the flag was a boolean with save/restore, an interleaving left
 * it stuck on:
 *
 *   A: prev = false; bypass = true
 *   B: prev = TRUE;  bypass = true
 *   A: restore false
 *   B: restore TRUE   <-- on for the rest of the request
 *
 * A stuck bypass makes getBranchContext() return null, and the MCP executor
 * fail-closes on that with "branch context missing". It looked impossible from
 * the outside: on one WhatsApp message a read tool succeeded and, a fraction of
 * a second later in the same scope, the write refused to run.
 *
 * These tests interleave deliberately, because the sequential case always
 * passed — which is exactly why the bug survived.
 */
describe('branch bypass under concurrency', () => {
  const CTX = {
    effectiveBranchId: null,
    accessibleBranchIds: ['branch-1'],
    isAllBranches: false,
    isGlobal: false,
  };

  const tick = (n = 0) => new Promise((r) => setTimeout(r, n));

  it('restores scoping after a single bypass', async () => {
    await runWithBranchStore(async () => {
      setBranchContext(CTX);
      await runWithBranchBypass(async () => {
        expect(getBranchContext()).toBeNull();
      });
      expect(getBranchContext()).toEqual(CTX);
    });
  });

  it('restores scoping after two bypasses that OVERLAP', async () => {
    // The interleaving that broke production.
    await runWithBranchStore(async () => {
      setBranchContext(CTX);

      const a = runWithBranchBypass(async () => {
        await tick(10);
      });
      const b = runWithBranchBypass(async () => {
        await tick(20);
      });
      await Promise.all([a, b]);

      expect(getBranchContext()).toEqual(CTX);
    });
  });

  it('keeps scoping off while any bypass is still open', async () => {
    await runWithBranchStore(async () => {
      setBranchContext(CTX);

      let seenInsideOuter: unknown = 'unset';
      const outer = runWithBranchBypass(async () => {
        await tick(20);
        // The inner bypass has already finished by now; scoping must still be
        // off, because THIS one has not.
        seenInsideOuter = getBranchContext();
      });
      const inner = runWithBranchBypass(async () => {
        await tick(5);
      });

      await Promise.all([outer, inner]);
      expect(seenInsideOuter).toBeNull();
      expect(getBranchContext()).toEqual(CTX);
    });
  });

  it('restores scoping when an overlapping bypass throws', async () => {
    await runWithBranchStore(async () => {
      setBranchContext(CTX);

      const ok = runWithBranchBypass(async () => {
        await tick(15);
      });
      const bad = runWithBranchBypass(async () => {
        await tick(5);
        throw new Error('boom');
      });

      await Promise.allSettled([ok, bad]);
      expect(getBranchContext()).toEqual(CTX);
    });
  });

  it('survives many overlapping bypasses', async () => {
    await runWithBranchStore(async () => {
      setBranchContext(CTX);
      await Promise.all(
        Array.from({ length: 25 }, (_, i) => runWithBranchBypass(() => tick(i % 7))),
      );
      expect(getBranchContext()).toEqual(CTX);
    });
  });

  it('a read then a write in one scope both see the context', async () => {
    // The production shape: preflight reads (some of which bypass), then the
    // action writes. The write used to be the one that failed.
    await runWithBranchStore(async () => {
      setBranchContext(CTX);

      const read = getBranchContext();
      await Promise.all([
        runWithBranchBypass(() => tick(5)),
        runWithBranchBypass(() => tick(10)),
      ]);
      const write = getBranchContext();

      expect(read).toEqual(CTX);
      expect(write).toEqual(CTX);
    });
  });

  it('nested bypasses do not clear early', async () => {
    await runWithBranchStore(async () => {
      setBranchContext(CTX);
      await runWithBranchBypass(async () => {
        await runWithBranchBypass(async () => undefined);
        // The inner one closed; the outer is still open.
        expect(getBranchContext()).toBeNull();
      });
      expect(getBranchContext()).toEqual(CTX);
    });
  });

  it('does nothing outside a store, rather than throwing', async () => {
    // Scripts and seeds run with no request context at all.
    await expect(runWithBranchBypass(async () => 'ok')).resolves.toBe('ok');
  });
});
