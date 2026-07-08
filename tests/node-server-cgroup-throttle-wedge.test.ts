/**
 * NODE-SERVER-CGROUP-THROTTLE-WEDGE — rotation must fire when
 * `memory.buffer.byteLength` grows, not only when `__heap_ptr` grows.
 *
 * Before this fix, worker rotation was gated only on
 * `(readHeapPtr() - initialHeapPtr) > 50 MB`. scope_pop rewinds `__heap_ptr`
 * but WASM `memory.grow()` is permanent — a single request that momentarily
 * needed 60 MB permanently extended the buffer, but the rotation check saw
 * `heapPtr - initialHeapPtr ≈ 0` after scope_pop, so the worker was kept.
 * With MAX_REQUEST_COUNT=1000, an enlarged instance lived for another ~999
 * requests, permanently occupying 60+ MB of RSS × pool workers. Under a
 * systemd cgroup MemoryMax ceiling, this is the wedge described in the
 * dashboard bug: process pinned in kernel `mem_cgroup_handle_over_high`.
 *
 * The fix measures rotation growth as
 *   max(heapPtr - initialHeapPtr, memory.buffer.byteLength - initialMemoryBytes)
 * so buffer growth that scope_pop cannot undo triggers instance recycling.
 */

import { describe, it, expect } from 'vitest';
import { computeRetainedGrowth, shouldRotate } from '../src/wasm/pool';

const MB = 1024 * 1024;

describe('NODE-SERVER-CGROUP-THROTTLE-WEDGE — rotation includes memory.buffer growth', () => {
  it('reports heap growth when heapPtr grew and buffer stayed flat', () => {
    // Compilers without scope_pop: __heap_ptr keeps advancing per request.
    const growth = computeRetainedGrowth(
      /* currentHeapPtr    */ 5 * MB,
      /* currentMemoryBytes */ 16 * MB,
      /* initialHeapPtr    */ 1 * MB,
      /* initialMemoryBytes */ 16 * MB,
    );
    expect(growth).toBe(4 * MB);
  });

  it('reports buffer growth when scope_pop rewound heapPtr but memory.grow() ran', () => {
    // Compiler >= 0.30.330 with scope_pop: heapPtr rewound to initial, but the
    // request called memory.grow() to satisfy a peak allocation. Buffer is
    // permanently larger. Pre-fix, growth was computed from heapPtr only and
    // came back 0 — rotation never fired.
    const growth = computeRetainedGrowth(
      /* currentHeapPtr    */ 1 * MB,
      /* currentMemoryBytes */ 80 * MB,
      /* initialHeapPtr    */ 1 * MB,
      /* initialMemoryBytes */ 16 * MB,
    );
    expect(growth).toBe(64 * MB);
  });

  it('reports the larger of the two when both grew', () => {
    const growth = computeRetainedGrowth(
      /* currentHeapPtr    */ 30 * MB,
      /* currentMemoryBytes */ 80 * MB,
      /* initialHeapPtr    */ 1 * MB,
      /* initialMemoryBytes */ 16 * MB,
    );
    expect(growth).toBe(64 * MB); // buffer growth (64MB) > heap growth (29MB)
  });

  it('never reports negative growth when metrics look inconsistent', () => {
    // Defensive: readHeapPtr fallback path can return the initial value on
    // post-trap reads. Growth must clamp to 0 rather than underflow.
    const growth = computeRetainedGrowth(
      /* currentHeapPtr    */ 500_000,
      /* currentMemoryBytes */ 16 * MB,
      /* initialHeapPtr    */ 1 * MB,
      /* initialMemoryBytes */ 16 * MB,
    );
    expect(growth).toBe(0);
  });

  it('shouldRotate fires when buffer growth exceeds threshold even at low request count', () => {
    // The specific regression: 1 request, heapPtr rewound to initial, but the
    // request triggered a memory.grow() that pushed the buffer 60 MB above
    // initial. Pre-fix, shouldRotate saw heapGrown=0 and returned false.
    const growth = computeRetainedGrowth(
      /* currentHeapPtr    */ 1 * MB,
      /* currentMemoryBytes */ 80 * MB,
      /* initialHeapPtr    */ 1 * MB,
      /* initialMemoryBytes */ 16 * MB,
    );
    expect(shouldRotate(/* requestCount */ 1, growth, /* maxRequests */ 1000, /* maxGrowthBytes */ 50 * MB)).toBe(true);
  });

  it('shouldRotate does NOT fire when both heapPtr and buffer are within thresholds', () => {
    const growth = computeRetainedGrowth(
      /* currentHeapPtr    */ 5 * MB,
      /* currentMemoryBytes */ 20 * MB,
      /* initialHeapPtr    */ 1 * MB,
      /* initialMemoryBytes */ 16 * MB,
    );
    expect(shouldRotate(/* requestCount */ 50, growth, 1000, 50 * MB)).toBe(false);
  });
});
