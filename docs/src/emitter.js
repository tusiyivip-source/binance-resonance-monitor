/**
 * 极简 EventEmitter —— 只有 on / off / once / emit / listenerCount。
 *
 * 为什么要自己写：engine.js 原本 `import { EventEmitter } from 'node:events'`，
 * 这一个 import 就把它钉死在 Node 上。换成这个之后，**同一份 engine.js
 * 浏览器也能直接跑**（用它监听告警，再由前端引导层转发成 SSE）。
 *
 * 语义与 node:events 在本项目用到的子集保持一致：emit 时某个监听器抛错
 * 会向上抛（与 Node 相同），由调用方自行 try/catch。
 */
export class Emitter {
  constructor() { this._events = new Map(); }

  on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    let list = this._events.get(type);
    if (!list) { list = []; this._events.set(type, list); }
    list.push(fn);
    return this;
  }

  once(type, fn) {
    const wrap = (...args) => { this.off(type, wrap); fn(...args); };
    wrap._origin = fn;
    return this.on(type, wrap);
  }

  off(type, fn) {
    const list = this._events.get(type);
    if (!list) return this;
    if (!fn) { this._events.delete(type); return this; }
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === fn || list[i]._origin === fn) list.splice(i, 1);
    }
    if (!list.length) this._events.delete(type);
    return this;
  }

  removeAllListeners(type) {
    if (type === undefined) this._events.clear();
    else this._events.delete(type);
    return this;
  }

  listenerCount(type) { return this._events.get(type)?.length ?? 0; }

  emit(type, ...args) {
    const list = this._events.get(type);
    if (!list || !list.length) return false;
    for (const fn of [...list]) fn(...args);
    return true;
  }
}
