import { describe, it, expect, vi } from 'vitest';
import { startMemoryGuard } from '../src/telemetry/memory-guard';

describe('startMemoryGuard', () => {
  it('fires onExceeded exactly once when RSS crosses the limit', async () => {
    const rssSpy = vi.spyOn(process, 'memoryUsage');
    // Report an RSS well above the limit immediately.
    rssSpy.mockReturnValue({
      rss: 500 * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    });

    const calls: number[] = [];
    const guard = startMemoryGuard(100 * 1024 * 1024, 20, (rss) => calls.push(rss));

    await new Promise((r) => setTimeout(r, 120));
    guard.stop();
    rssSpy.mockRestore();

    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(500 * 1024 * 1024);
  });

  it('does not fire when RSS stays below the limit', async () => {
    const rssSpy = vi.spyOn(process, 'memoryUsage');
    rssSpy.mockReturnValue({
      rss: 50 * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    });

    let fired = false;
    const guard = startMemoryGuard(100 * 1024 * 1024, 20, () => { fired = true; });

    await new Promise((r) => setTimeout(r, 120));
    guard.stop();
    rssSpy.mockRestore();

    expect(fired).toBe(false);
  });

  it('stop() prevents further sampling', async () => {
    const rssSpy = vi.spyOn(process, 'memoryUsage');
    let sampleCount = 0;
    rssSpy.mockImplementation(() => {
      sampleCount++;
      return { rss: 1, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
    });

    const guard = startMemoryGuard(100 * 1024 * 1024, 20, () => {});
    await new Promise((r) => setTimeout(r, 60));
    guard.stop();
    const countAtStop = sampleCount;
    await new Promise((r) => setTimeout(r, 80));
    rssSpy.mockRestore();

    expect(sampleCount).toBe(countAtStop);
  });
});
