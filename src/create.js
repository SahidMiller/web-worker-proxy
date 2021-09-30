/* @flow */

import intercept from './intercept';
import uid from './uid';
import { serialize, deserialize } from './transfer';
import {
  ACTION_OPERATION,
  ACTION_DISPOSE,
  RESULT_SUCCESS,
  RESULT_ERROR,
  RESULT_CALLBACK,
  TYPE_FUNCTION,
  TYPE_PERSISTED_FUNCTION,
} from './constants';
import type { Worker } from './types';

type CreateOptions = {
  +send: (data: mixed) => mixed,
  +get: (data: mixed) => mixed
}

/**
 * Creates a proxied web worker.
 * This should be called in the DOM context.
 */
export default function create(worker: Worker, options: CreateOptions): any {
  const deferred = {};
  
  // Send actions to the worker and wait for result
  const send = function (type, data) {

    const sentManualRetValue = options && options.send && options.send(data, (actions, result) => {
      return intercept(operations => send(ACTION_OPERATION, operations), result, actions, result)
    });

    if (typeof sentManualRetValue !== 'undefined') return sentManualRetValue

    return new Promise((resolve, reject) => {
      // Unique id to identify the current action
      const id = uid();

      // For function calls, store any callbacks we're sending
      const callbacks = new Map();

      if (type === ACTION_OPERATION) {
        const last = data[data.length - 1] || {};

        if (last.type === 'apply') {
          // If we have a function call, map callbacks in the function call to refs
          /* $FlowFixMe */
          last.args = last.args.map(arg => {
            // If the argument is a callback function, we create a ref and store the function
            // We also replace the argument with the ref instead
            // Otherwise we just return it
            if (typeof arg === 'function') {
              const ref = uid();
              callbacks.set(ref, arg);
              return {
                type: TYPE_FUNCTION,
                ref,
              };
            }

            // Persisted functions are like normal functions, but can be called multiple times
            // We clean it up only when the user disposes it
            if (arg != null && arg.type === TYPE_PERSISTED_FUNCTION) {
              const ref = uid();
              callbacks.set(ref, arg);

              // Add a listener to the persisted function to listen for dispose
              // When the function is disposed, we delete it and remove the listeners
              // We also notify the worker that this function is disposed and can no longer be called
              arg.on('dispose', () => {
                callbacks.delete(ref);
                removeListener();

                worker.postMessage({
                  type: ACTION_DISPOSE,
                  ref,
                });
              });

              return {
                type: TYPE_FUNCTION,
                ref,
                persisted: true,
              };
            }

            return serialize(arg);
          });
        } else if (last.type === 'set') {
          last.value = serialize(last.value);
        }
      }

      deferred[id] = { resolve, reject, callbacks, type, id, data, count: count++ };
      worker.postMessage({ type, id, data });
    });
  }
  
  // Listener to handle incoming messages from the worker
  worker.onmessage = e => {
    const id = e.data.id;
    const deferredPromise = deferred[e.data.id];

    if (deferredPromise) {
      const { resolve, reject, callbacks, fulfilled } = deferredPromise;
      
      const setFulfilled = () => {
        deferredPromise.fulfilled = true;
      }

      // Store a variable to indicate whether the task has been fulfilled
      const removeListener = () => {
        
        if (callbacks.size === 0 && fulfilled) {          
          // Remove the listener once there are no callbacks left and task is fulfilled
          delete deferred[id];
        }       
      }

      switch (e.data.type) {
        case RESULT_SUCCESS:
          // If the success result was for current action, resolve the promise
          resolve(deserialize(e.data.result));

          setFulfilled(true);

          removeListener();  
          break;
  
        case RESULT_ERROR:
          reject(deserialize(e.data.error));

          setFulfilled(true);

          removeListener();
          break;
  
        case RESULT_CALLBACK:
          // Get the referenced callback
          const { ref, args } = e.data.func;
          const callback = callbacks.get(ref);

          if (callback) {
            callback.apply(null, args.map(deserialize));

            if (callback.type !== TYPE_PERSISTED_FUNCTION) {
              // Remove the callback if it's not persisted
              callbacks.delete(ref);
            }
          } else {
            // Function is already disposed
            // This shouldn't happen
          }

          removeListener();
      }
    }
  };

  return intercept(operations => send(ACTION_OPERATION, operations));
}
