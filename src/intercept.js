/* @flow */

import { data } from 'core-js/internals/is-forced';
import type { Action } from './types';
import { Readable, Writable } from 'stream';

/**
 * Intercepts actions such as property access, function call etc. and records in an array.
 */
export default function intercept(
  callback: (Action[]) => Promise<mixed>,
  previousTarget: Function | Object = {},
  actions: Action[] = [],
  lastResult: Object
): any {
  // We execute the promise lazily and cache it here to avoid calling again
  let promise;
  let isPromise;

  const proxy = new Proxy(previousTarget, {
    construct(target, args) {
      const previous = actions.slice(0, actions.length - 1);
      const last = actions[actions.length - 1];

      // It's an object construction
      return callback([
        ...previous,
        { type: 'construct', key: last.key, args },
      ]);
    },
    get(target, key) {
      if (key === "then" && isPromise) {
        return proxy;
      }
      
      // Intercept fn.apply by returning a new intercept that acts as the old
      if (key === "apply") {
        return (_, args) => target(...args);
      }

      if (key === "call") {
        return (_, ...args) => target(...args);
      }

      if (key === "name") {
        const last = actions[actions.length - 1];
        return last.key;
      }

      if (globalThis.debugFns && globalThis.debugFns.indexOf(key) !== -1) {
        debugger;
      }

      if (key === Symbol.toPrimitive) {
        return () => callback(actions)
      }

      // Intercept object values from previous response
      if (lastResult) {
        if (lastResult.hasOwnProperty(key)) {
          const result = lastResult[key];
          const isPrimitive = result !== Object(result) || result.type === "Buffer" || result instanceof Array || result instanceof Readable || result instanceof Writable || result instanceof Date
          if (isPrimitive) return result;
        } 

        if (key === "then") {
          return intercept(callback, (success) => {
            isPromise = true;
            success(proxy)
          }, actions, lastResult)
        }
      }

      // Here we intercept both function calls and property access
      // If the key was `then`, we create a `thenable` so that the result can be awaited
      // This makes sure that the result can be used like a promise in case it's a property access
      if (key === 'then') {
        const then = (success, error) => {
          if (!promise) {
            // If the cached promise doesn't exist, create a new promise and cache it
            promise = callback(actions);
          }

          return promise.then(success, error);
        };

        // Return a proxy for the thenable which can be executed to get a promise
        // If properties are accessed instead, we'll intercept them and treat them as usual
        return intercept(callback, then, [...actions, { type: 'get', key }]);
      }
      
      function func(...args) {
        // It's a function call
        let result = callback([...actions, { type: 'apply', key, args }]);
        const isPrimitive = result !== Object(result) || result.type === "Buffer" || result instanceof Array || result instanceof Readable || result instanceof Writable || result instanceof Date

        if (result && result.type === "Buffer") {
          result = Buffer.from(result.data);
        }

        return isPrimitive ? result : intercept(callback, func, [...actions, { type: 'apply', key, args }], result);
      }

      return intercept(callback, func, [...actions, { type: 'get', key }]);
    },
    /* $FlowFixMe */
    set(target, key, value) {
      // Trigger setting the key
      // This might fail, but we can't throw an error synchornously, so return a promise indicating the value
      // In case of an error, the promise will be rejected and the browser will throw an error
      // If setting the property fails in the worker, the promise will resolve to false
      return callback([...actions, { type: 'set', key, value }]);
    },
  });

  return proxy
}
