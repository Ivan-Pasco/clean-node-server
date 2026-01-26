/**
 * Create math bridge functions
 *
 * Provides mathematical operations for WASM modules.
 * All functions operate on f64 values unless otherwise noted.
 */
export function createMathBridge() {
  return {
    // Trigonometric functions
    math_sin(x: number): number {
      return Math.sin(x);
    },

    math_cos(x: number): number {
      return Math.cos(x);
    },

    math_tan(x: number): number {
      return Math.tan(x);
    },

    math_asin(x: number): number {
      return Math.asin(x);
    },

    math_acos(x: number): number {
      return Math.acos(x);
    },

    math_atan(x: number): number {
      return Math.atan(x);
    },

    math_atan2(y: number, x: number): number {
      return Math.atan2(y, x);
    },

    math_sinh(x: number): number {
      return Math.sinh(x);
    },

    math_cosh(x: number): number {
      return Math.cosh(x);
    },

    math_tanh(x: number): number {
      return Math.tanh(x);
    },

    // Exponential and logarithmic functions
    math_sqrt(x: number): number {
      return Math.sqrt(x);
    },

    math_cbrt(x: number): number {
      return Math.cbrt(x);
    },

    math_pow(base: number, exponent: number): number {
      return Math.pow(base, exponent);
    },

    math_exp(x: number): number {
      return Math.exp(x);
    },

    math_exp2(x: number): number {
      return Math.pow(2, x);
    },

    math_expm1(x: number): number {
      return Math.expm1(x);
    },

    math_log(x: number): number {
      return Math.log(x);
    },

    math_log10(x: number): number {
      return Math.log10(x);
    },

    math_log2(x: number): number {
      return Math.log2(x);
    },

    math_log1p(x: number): number {
      return Math.log1p(x);
    },

    // Rounding functions
    math_abs(x: number): number {
      return Math.abs(x);
    },

    math_floor(x: number): number {
      return Math.floor(x);
    },

    math_ceil(x: number): number {
      return Math.ceil(x);
    },

    math_round(x: number): number {
      return Math.round(x);
    },

    math_trunc(x: number): number {
      return Math.trunc(x);
    },

    math_sign(x: number): number {
      return Math.sign(x);
    },

    // Min/Max functions
    math_min(a: number, b: number): number {
      return Math.min(a, b);
    },

    math_max(a: number, b: number): number {
      return Math.max(a, b);
    },

    math_clamp(value: number, min: number, max: number): number {
      return Math.min(Math.max(value, min), max);
    },

    // Other mathematical functions
    math_hypot(x: number, y: number): number {
      return Math.hypot(x, y);
    },

    math_fmod(x: number, y: number): number {
      return x % y;
    },

    // Random number generation
    math_random(): number {
      return Math.random();
    },

    math_random_int(min: number, max: number): number {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },

    // Constants (returned as functions for WASM compatibility)
    math_pi(): number {
      return Math.PI;
    },

    math_e(): number {
      return Math.E;
    },

    math_ln2(): number {
      return Math.LN2;
    },

    math_ln10(): number {
      return Math.LN10;
    },

    math_log2e(): number {
      return Math.LOG2E;
    },

    math_log10e(): number {
      return Math.LOG10E;
    },

    math_sqrt2(): number {
      return Math.SQRT2;
    },

    math_sqrt1_2(): number {
      return Math.SQRT1_2;
    },

    // Integer-specific operations
    math_abs_i32(x: number): number {
      return Math.abs(x) | 0;
    },

    math_min_i32(a: number, b: number): number {
      return Math.min(a, b) | 0;
    },

    math_max_i32(a: number, b: number): number {
      return Math.max(a, b) | 0;
    },

    // Floating point checks
    math_is_nan(x: number): number {
      return Number.isNaN(x) ? 1 : 0;
    },

    math_is_finite(x: number): number {
      return Number.isFinite(x) ? 1 : 0;
    },

    math_is_infinite(x: number): number {
      return !Number.isFinite(x) && !Number.isNaN(x) ? 1 : 0;
    },
  };
}
