import { AsyncLocalStorage } from "node:async_hooks";

import {
  ROOT_CONTEXT,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";

export class WorkerContextManager implements ContextManager {
  private storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const callback = thisArg === undefined ? fn : fn.bind(thisArg);
    return this.storage.run(activeContext, callback, ...args);
  }

  bind<T>(activeContext: Context, target: T): T {
    if (typeof target !== "function") {
      return target;
    }
    const manager = this;
    const callable = target as (...args: unknown[]) => unknown;
    return function (this: unknown, ...args: unknown[]) {
      return manager.with(activeContext, callable, this, ...args);
    } as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    // Workers intentionally omits AsyncLocalStorage.disable(). Replacing the
    // store gives future operations a clean context without using that API.
    this.storage = new AsyncLocalStorage<Context>();
    return this;
  }
}
