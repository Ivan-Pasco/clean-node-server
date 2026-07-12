/**
 * Math bridge tests — createMathBridge
 *
 * Alignment: positive-path contract for all math operations.
 * Category: contract
 *
 * Tests cover: trig (sin/cos/tan/asin/acos/atan/atan2), hyperbolic
 * (sinh/cosh/tanh), exp/log (sqrt/cbrt/pow/exp/log/log10/log2),
 * rounding (abs/floor/ceil/round/trunc/sign), min/max/clamp/hypot/fmod,
 * float checks (is_nan/is_finite/is_infinite), integer variants
 * (abs_i32/min_i32/max_i32), constants (pi/e/ln2/sqrt2), and random.
 */

import { describe, it, expect } from 'vitest';
import { createMathBridge } from '../src/bridge/math';

const bridge = createMathBridge();

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Math bridge — trigonometric functions', () => {
  it('math_sin / math_cos / math_tan return correct values for known inputs', () => {
    expect(bridge.math_sin(0)).toBeCloseTo(0);
    expect(bridge.math_sin(Math.PI / 2)).toBeCloseTo(1);
    expect(bridge.math_cos(0)).toBeCloseTo(1);
    expect(bridge.math_cos(Math.PI)).toBeCloseTo(-1);
    expect(bridge.math_tan(Math.PI / 4)).toBeCloseTo(1);
    expect(bridge.math_tan(0)).toBeCloseTo(0);
  });

  it('math_asin / math_acos / math_atan are inverse of sin/cos/tan', () => {
    expect(bridge.math_asin(1)).toBeCloseTo(Math.PI / 2);
    expect(bridge.math_acos(1)).toBeCloseTo(0);
    expect(bridge.math_atan(1)).toBeCloseTo(Math.PI / 4);
  });

  it('math_atan2 computes angle from y/x pair correctly', () => {
    expect(bridge.math_atan2(1, 1)).toBeCloseTo(Math.PI / 4);
    expect(bridge.math_atan2(0, -1)).toBeCloseTo(Math.PI);
    expect(bridge.math_atan2(1, 0)).toBeCloseTo(Math.PI / 2);
  });

  it('math_sinh / math_cosh / math_tanh match JS equivalents', () => {
    expect(bridge.math_sinh(0)).toBeCloseTo(0);
    expect(bridge.math_cosh(0)).toBeCloseTo(1);
    expect(bridge.math_tanh(0)).toBeCloseTo(0);
    expect(bridge.math_tanh(Infinity)).toBeCloseTo(1);
  });
});

describe('Math bridge — exponential and logarithmic functions', () => {
  it('math_sqrt and math_cbrt compute correct roots', () => {
    expect(bridge.math_sqrt(9)).toBeCloseTo(3);
    expect(bridge.math_sqrt(2)).toBeCloseTo(Math.SQRT2);
    expect(bridge.math_cbrt(27)).toBeCloseTo(3);
    expect(bridge.math_cbrt(8)).toBeCloseTo(2);
  });

  it('math_pow computes base^exponent correctly', () => {
    expect(bridge.math_pow(2, 10)).toBe(1024);
    expect(bridge.math_pow(3, 3)).toBe(27);
    expect(bridge.math_pow(4, 0.5)).toBeCloseTo(2);
  });

  it('math_exp and math_log are inverses', () => {
    expect(bridge.math_exp(0)).toBeCloseTo(1);
    expect(bridge.math_exp(1)).toBeCloseTo(Math.E);
    expect(bridge.math_log(Math.E)).toBeCloseTo(1);
    expect(bridge.math_log(1)).toBeCloseTo(0);
  });

  it('math_log10 and math_log2 use correct bases', () => {
    expect(bridge.math_log10(100)).toBeCloseTo(2);
    expect(bridge.math_log10(1)).toBeCloseTo(0);
    expect(bridge.math_log2(8)).toBeCloseTo(3);
    expect(bridge.math_log2(1)).toBeCloseTo(0);
  });

  it('math_exp2 and math_expm1 and math_log1p work correctly', () => {
    expect(bridge.math_exp2(3)).toBeCloseTo(8);
    expect(bridge.math_expm1(0)).toBeCloseTo(0);
    expect(bridge.math_log1p(0)).toBeCloseTo(0);
    expect(bridge.math_log1p(Math.E - 1)).toBeCloseTo(1);
  });
});

describe('Math bridge — rounding functions', () => {
  it('math_floor / math_ceil / math_round / math_trunc all round correctly', () => {
    expect(bridge.math_floor(3.7)).toBe(3);
    expect(bridge.math_floor(-3.2)).toBe(-4);
    expect(bridge.math_ceil(3.2)).toBe(4);
    expect(bridge.math_ceil(-3.7)).toBe(-3);
    expect(bridge.math_round(3.5)).toBe(4);
    expect(bridge.math_round(3.4)).toBe(3);
    expect(bridge.math_trunc(3.9)).toBe(3);
    expect(bridge.math_trunc(-3.9)).toBe(-3);
  });

  it('math_abs and math_sign handle positive, negative, and zero', () => {
    expect(bridge.math_abs(-7)).toBe(7);
    expect(bridge.math_abs(7)).toBe(7);
    expect(bridge.math_abs(0)).toBe(0);
    expect(bridge.math_sign(-5)).toBe(-1);
    expect(bridge.math_sign(5)).toBe(1);
    expect(bridge.math_sign(0)).toBe(0);
  });
});

describe('Math bridge — min / max / clamp / hypot / fmod', () => {
  it('math_min and math_max select correct value', () => {
    expect(bridge.math_min(3, 7)).toBe(3);
    expect(bridge.math_min(-1, 1)).toBe(-1);
    expect(bridge.math_max(3, 7)).toBe(7);
    expect(bridge.math_max(-1, 1)).toBe(1);
  });

  it('math_clamp constrains value within [min, max]', () => {
    expect(bridge.math_clamp(5, 0, 10)).toBe(5);
    expect(bridge.math_clamp(-5, 0, 10)).toBe(0);
    expect(bridge.math_clamp(15, 0, 10)).toBe(10);
  });

  it('math_hypot and math_fmod work correctly', () => {
    expect(bridge.math_hypot(3, 4)).toBeCloseTo(5);
    expect(bridge.math_hypot(0, 5)).toBeCloseTo(5);
    expect(bridge.math_fmod(10, 3)).toBeCloseTo(1);
    expect(bridge.math_fmod(7.5, 2.5)).toBeCloseTo(0);
  });
});

describe('Math bridge — integer variants', () => {
  it('math_abs_i32 / math_min_i32 / math_max_i32 return integer results', () => {
    expect(bridge.math_abs_i32(-42)).toBe(42);
    expect(bridge.math_abs_i32(42)).toBe(42);
    expect(bridge.math_min_i32(3, 7)).toBe(3);
    expect(bridge.math_max_i32(3, 7)).toBe(7);
    // Values are int-truncated
    expect(Number.isInteger(bridge.math_abs_i32(-3))).toBe(true);
  });
});

describe('Math bridge — float checks', () => {
  it('math_is_nan returns 1 for NaN and 0 otherwise', () => {
    expect(bridge.math_is_nan(NaN)).toBe(1);
    expect(bridge.math_is_nan(0)).toBe(0);
    expect(bridge.math_is_nan(42)).toBe(0);
  });

  it('math_is_finite returns 1 for finite and 0 for Infinity/NaN', () => {
    expect(bridge.math_is_finite(42)).toBe(1);
    expect(bridge.math_is_finite(Infinity)).toBe(0);
    expect(bridge.math_is_finite(NaN)).toBe(0);
  });

  it('math_is_infinite returns 1 for Infinity and 0 for finite/NaN', () => {
    expect(bridge.math_is_infinite(Infinity)).toBe(1);
    expect(bridge.math_is_infinite(-Infinity)).toBe(1);
    expect(bridge.math_is_infinite(42)).toBe(0);
    expect(bridge.math_is_infinite(NaN)).toBe(0);
  });
});

describe('Math bridge — constants and random', () => {
  it('math_pi / math_e / math_ln2 / math_sqrt2 return correct constants', () => {
    expect(bridge.math_pi()).toBeCloseTo(Math.PI);
    expect(bridge.math_e()).toBeCloseTo(Math.E);
    expect(bridge.math_ln2()).toBeCloseTo(Math.LN2);
    expect(bridge.math_sqrt2()).toBeCloseTo(Math.SQRT2);
  });

  it('math_ln10 / math_log2e / math_log10e / math_sqrt1_2 are correct', () => {
    expect(bridge.math_ln10()).toBeCloseTo(Math.LN10);
    expect(bridge.math_log2e()).toBeCloseTo(Math.LOG2E);
    expect(bridge.math_log10e()).toBeCloseTo(Math.LOG10E);
    expect(bridge.math_sqrt1_2()).toBeCloseTo(Math.SQRT1_2);
  });

  it('math_random returns a number in [0, 1)', () => {
    for (let i = 0; i < 10; i++) {
      const v = bridge.math_random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('math_random_int(min, max) stays within inclusive [min, max]', () => {
    for (let i = 0; i < 20; i++) {
      const v = bridge.math_random_int(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(10);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
