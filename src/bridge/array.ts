import { WasmState } from '../types';
import { log } from './helpers';

const arrayStore = new Map<number, any[]>();
let nextHandle = 1;

export function getArrayStore(): Map<number, any[]> {
  return arrayStore;
}

export function resetArrayStore(): void {
  arrayStore.clear();
  nextHandle = 1;
}

function storeArray(arr: any[]): number {
  const handle = nextHandle++;
  arrayStore.set(handle, arr);
  return handle;
}

function callWasmCallback(state: WasmState, callbackIdx: number, ...args: number[]): number {
  const table = (state.exports as any).__indirect_function_table;
  if (!table) {
    log(state, 'ARRAY', 'No function table available for callback');
    return 0;
  }

  const fn = table.get(callbackIdx);
  if (typeof fn !== 'function') {
    log(state, 'ARRAY', `Invalid callback at index ${callbackIdx}`);
    return 0;
  }

  return fn(...args) as number;
}

function toWasmValue(element: any): number {
  if (typeof element === 'string') {
    return 0; // Strings shouldn't appear as raw values in WASM arrays
  }
  return element ?? 0;
}

export function createArrayBridge(getState: () => WasmState) {
  return {
    array_get(arr_ptr: number, index: number): number {
      const state = getState();
      const arr = arrayStore.get(arr_ptr);

      if (!arr) {
        log(state, 'ARRAY', `Invalid array handle: ${arr_ptr}`);
        return 0;
      }

      if (index < 0 || index >= arr.length) {
        return 0;
      }

      return toWasmValue(arr[index]);
    },

    array_set(arr_ptr: number, index: number, value: number): void {
      const state = getState();
      const arr = arrayStore.get(arr_ptr);

      if (!arr) {
        log(state, 'ARRAY', `Invalid array handle: ${arr_ptr}`);
        return;
      }

      if (index < 0 || index >= arr.length) {
        return;
      }

      arr[index] = value;
    },

    array_push(arr_ptr: number, value: number): number {
      const state = getState();
      const arr = arrayStore.get(arr_ptr);

      if (!arr) {
        log(state, 'ARRAY', `Invalid array handle: ${arr_ptr}`);
        return 0;
      }

      arr.push(value);
      return arr_ptr;
    },

    array_pop(arr_ptr: number): number {
      const state = getState();
      const arr = arrayStore.get(arr_ptr);

      if (!arr || arr.length === 0) {
        return 0;
      }

      return arr.pop() ?? 0;
    },

    array_slice(arr_ptr: number, start: number, end: number): number {
      const state = getState();
      const arr = arrayStore.get(arr_ptr);

      if (!arr) {
        log(state, 'ARRAY', `Invalid array handle: ${arr_ptr}`);
        return 0;
      }

      return storeArray(arr.slice(start, end));
    },

    array_concat(arr_ptr1: number, arr_ptr2: number): number {
      const state = getState();
      const arr1 = arrayStore.get(arr_ptr1);
      const arr2 = arrayStore.get(arr_ptr2);

      if (!arr1 || !arr2) {
        log(state, 'ARRAY', `Invalid array handle: ${!arr1 ? arr_ptr1 : arr_ptr2}`);
        return 0;
      }

      return storeArray(arr1.concat(arr2));
    },

    array_reverse(arr_ptr: number): number {
      const state = getState();
      const arr = arrayStore.get(arr_ptr);

      if (!arr) {
        log(state, 'ARRAY', `Invalid array handle: ${arr_ptr}`);
        return 0;
      }

      return storeArray([...arr].reverse());
    },

    array_sort(arr_ptr: number): number {
      const state = getState();
      const arr = arrayStore.get(arr_ptr);

      if (!arr) {
        log(state, 'ARRAY', `Invalid array handle: ${arr_ptr}`);
        return 0;
      }

      return storeArray([...arr].sort((a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
        return 0;
      }));
    },

    array_filter(arr_ptr: number, callback_idx: number): number {
      const state = getState();
      const arr = arrayStore.get(arr_ptr);

      if (!arr) {
        log(state, 'ARRAY', `Invalid array handle: ${arr_ptr}`);
        return 0;
      }

      const filtered = arr.filter((element) => {
        return callWasmCallback(state, callback_idx, toWasmValue(element)) !== 0;
      });

      return storeArray(filtered);
    },

    array_map(arr_ptr: number, callback_idx: number): number {
      const state = getState();
      const arr = arrayStore.get(arr_ptr);

      if (!arr) {
        log(state, 'ARRAY', `Invalid array handle: ${arr_ptr}`);
        return 0;
      }

      const mapped = arr.map((element) => {
        return callWasmCallback(state, callback_idx, toWasmValue(element));
      });

      return storeArray(mapped);
    },

    array_reduce(arr_ptr: number, callback_idx: number, initial: number): number {
      const state = getState();
      const arr = arrayStore.get(arr_ptr);

      if (!arr) {
        log(state, 'ARRAY', `Invalid array handle: ${arr_ptr}`);
        return 0;
      }

      let accumulator = initial;
      for (const element of arr) {
        accumulator = callWasmCallback(state, callback_idx, accumulator, toWasmValue(element));
      }

      return accumulator;
    },

    array_find(arr_ptr: number, callback_idx: number): number {
      const state = getState();
      const arr = arrayStore.get(arr_ptr);

      if (!arr) {
        log(state, 'ARRAY', `Invalid array handle: ${arr_ptr}`);
        return 0;
      }

      for (const element of arr) {
        const val = toWasmValue(element);
        if (callWasmCallback(state, callback_idx, val) !== 0) {
          return val;
        }
      }

      return 0;
    },

    array_contains(arr_ptr: number, value: number): number {
      const state = getState();
      const arr = arrayStore.get(arr_ptr);

      if (!arr) {
        log(state, 'ARRAY', `Invalid array handle: ${arr_ptr}`);
        return 0;
      }

      return arr.includes(value) ? 1 : 0;
    },
  };
}
