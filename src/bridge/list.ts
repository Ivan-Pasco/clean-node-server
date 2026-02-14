import { WasmState } from '../types';
import { log } from './helpers';

const listStore = new Map<number, any[]>();
let nextHandle = 1;

export function getListStore(): Map<number, any[]> {
  return listStore;
}

export function resetListStore(): void {
  listStore.clear();
  nextHandle = 1;
}

export function createListBridge(getState: () => WasmState) {
  return {
    'list.allocate'(_capacity: number): number {
      const handle = nextHandle++;
      listStore.set(handle, []);
      return handle;
    },

    'list.push'(list_ptr: number, value: number): void {
      const list = listStore.get(list_ptr);

      if (!list) {
        log(getState(), 'LIST', `Invalid list handle: ${list_ptr}`);
        return;
      }

      list.push(value | 0);
    },

    'list.push_f64'(list_ptr: number, value: number): void {
      const list = listStore.get(list_ptr);

      if (!list) {
        log(getState(), 'LIST', `Invalid list handle: ${list_ptr}`);
        return;
      }

      list.push(+value);
    },

    'list.add'(list_ptr: number, value_ptr: number): void {
      const list = listStore.get(list_ptr);

      if (!list) {
        log(getState(), 'LIST', `Invalid list handle: ${list_ptr}`);
        return;
      }

      list.push(value_ptr);
    },

    'list.clear'(list_ptr: number): void {
      const list = listStore.get(list_ptr);

      if (!list) {
        log(getState(), 'LIST', `Invalid list handle: ${list_ptr}`);
        return;
      }

      list.length = 0;
    },

    'list.get'(list_ptr: number, index: number): number {
      const list = listStore.get(list_ptr);

      if (!list) {
        log(getState(), 'LIST', `Invalid list handle: ${list_ptr}`);
        return 0;
      }

      if (index < 0 || index >= list.length) {
        return 0;
      }

      return list[index];
    },

    'list.set'(list_ptr: number, index: number, value: number): void {
      const list = listStore.get(list_ptr);

      if (!list) {
        log(getState(), 'LIST', `Invalid list handle: ${list_ptr}`);
        return;
      }

      if (index < 0 || index >= list.length) {
        return;
      }

      list[index] = value;
    },

    'list.remove'(list_ptr: number, index: number): void {
      const list = listStore.get(list_ptr);

      if (!list) {
        log(getState(), 'LIST', `Invalid list handle: ${list_ptr}`);
        return;
      }

      if (index < 0 || index >= list.length) {
        return;
      }

      list.splice(index, 1);
    },

    'list.contains'(list_ptr: number, value: number): number {
      const list = listStore.get(list_ptr);

      if (!list) {
        log(getState(), 'LIST', `Invalid list handle: ${list_ptr}`);
        return 0;
      }

      return list.includes(value) ? 1 : 0;
    },

    'list.isEmpty'(list_ptr: number): number {
      const list = listStore.get(list_ptr);

      if (!list) {
        log(getState(), 'LIST', `Invalid list handle: ${list_ptr}`);
        return 0;
      }

      return list.length === 0 ? 1 : 0;
    },
  };
}
