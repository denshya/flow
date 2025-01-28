import { Messager } from "./Messages"
import createReactiveAccessor from "./ReactiveAccessor"
import { Signal } from "./Signal"
import { AccessorSet, AccessorGet, Guarded, Observable, Unsubscribe } from "./types"
import { isFlowRead } from "./utils"


export class Flow<T> extends Signal<T> {
  static of<T>(items: (T | Flow<T>)[]): Flow<T>[] {
    return items.map(Flow.from)
  }

  static from<T>(item: T | Flow<T> | FlowRead<T>): Flow<T> {
    if (item instanceof Flow) return item
    if (item instanceof Object && ("get" in item) && (Symbol.subscribe in item)) {
      const fork = new Flow(item.get())

      item[Symbol.subscribe](value => fork.set(value))

      return fork
    }

    return new Flow(item)
  }

  static all<const T extends FlowRead<unknown>[]>(flows: T): Flow<{ [K in keyof T]: ExtractFlowable<T[K]> }> {
    return Flow.compute((...values) => values, flows)
  }

  static compute<const States extends unknown[], U>(predicate: (...values: { [K in keyof States]: ExtractFlowable<States[K]> }) => U, states: States): Flow<U> {
    const values = states.map(Flow.get)

    const computed = new Flow(predicate(...values as never))

    states.forEach((state, index) => {
      Flow.from(state)[Symbol.subscribe](value => {
        values[index] = value
        computed.set(predicate(...values as never))
      })
    })

    return computed
  }

  static computeRecord<T extends Record<keyof never, unknown>>(record: T): Flow<{ [K in keyof T]: ExtractFlowable<T[K]> }> {
    const result = {} as any
    const recordFlow = new Flow(result)

    for (const [key, value] of Object.entries(record)) {
      const valueFlow = Flow.from(value)

      result[key] = valueFlow.get()
      valueFlow[Symbol.subscribe](it => {
        result[key] = it
        recordFlow.set(result)
      })
    }

    return recordFlow as never
  }

  static get<T>(value: Flowable<T>): T {
    return isFlowRead(value) ? value.get() : value
  }
  static getDeep<T>(value: T): FlowFlatten<T> {
    return (isFlowRead(value) ? Flow.getDeep(value.get()) : value) as never
  }

  static for<Args extends unknown[], Return>(fn: (...args: Args) => Return): (...args: { [K in keyof Args]: Flowable<Args[K]> }) => FlowRead<Return> {
    return (...args) => Flow.compute(fn, args as never).readonly()
  }

  static f(strings: TemplateStringsArray, ...values: unknown[]): Flow<string> {
    return Flow.compute((...values) => strings.map((string, i) => string + String(values[i] ?? "")).join(""), values)
  }

  static lock(flow: Flow<unknown>): Disposable { }

  // flat(value: T): FlowFlatten<T> {
  //   if (!isFlowRead(value)) return value

  //   let next: unknown = value

  //   const flow = new Flow({})
  //   while (isFlowRead(next)) {
  //     next[Symbol.subscribe](it => {
  //       const v = getDeep(it)
  //       if (v === flow.get()) return

  //       flow.set(v)
  //     })
  //     next = next.get()
  //   }

  //   flow.value = next
  //   flow.sets(it => value.set(value.get()))
  //   return flow as never
  // }

  sets<U>(other: AccessorSet<T | U>): Unsubscribe
  sets(callback: (value: T) => void): Unsubscribe
  sets<U>(arg: AccessorSet<T | U> | ((value: T) => void)): Unsubscribe {
    return this[Symbol.subscribe](value => {
      arg instanceof Function ? arg(value) : arg.set(value)
    })
  }
  copy(other: AccessorGet<T>) { this.set(other.get()) }

  /** 
   * Disables propagation until the lock is disposed.
   * 
   * @example
   * state.sets(it => {
   *   using lock = Flow.lock(state)
   * })
   */
  lock(): Disposable { }

  readonly $ = createReactiveAccessor(this)

  get it() { return this.value }
  set it(value: T) { this.set(value) }

  to<U>(predicate: (value: T) => U): Flow<U> {
    const fork = new Flow(predicate(this.value))
    this[Symbol.subscribe](value => {
      const newValue = predicate(value)
      if (newValue === fork.value) return

      fork.set(newValue)
    })
    return fork
  }

  from(predicate: (value: T) => T): Flow<T> {
    const fork = new Flow(this.value)
    const set = fork.set

    fork.set = value => set.call(fork, value instanceof Function ? predicate(value(fork.value)) : predicate(value))
    this.sets(fork)

    return fork
  }

  fork() { new Flow(this.get()) }
  clone() {
    const cloned = new Flow(this.get())
    this.sets(cloned)
    return cloned
  }

  readonly(): FlowRead<T> {
    return { get: () => this.get(), [Symbol.subscribe]: next => this[Symbol.subscribe](next) }
  }

  writeonly(): FlowWrite<T> {
    return { set: v => this.set(v) }
  }

  is(predicate: (value: T) => boolean): FlowRead<boolean>
  is<U extends T>(predicate: (value: T) => value is U): FlowRead<boolean> {
    return { get: () => predicate(this.get()), [Symbol.subscribe]: next => this[Symbol.subscribe](value => next(predicate(value))) }
  }
  readonly isNullish: FlowRead<boolean> = this.is(value => value == null)
  readonly isNotNullish: FlowRead<boolean> = this.is(value => value != null)

  guard<U extends T>(predicate: (value: T) => boolean): Guarded<U, T> & FlowRead<T>
  guard<U extends T>(predicate: (value: T) => value is U): Guarded<U, T> & FlowRead<T> {
    const guardedState = this.readonly() as Guarded<U, T> & FlowRead<T>
    guardedState.valid = predicate

    return guardedState
  }
  readonly nullable: Guarded<T | null | undefined, T | null | undefined> & FlowRead<T> = this.guard(value => value == null)
  readonly nonNullable: Guarded<T & {}, T> & FlowRead<T & {}> = this.guard(value => value != null) as never
  readonly required: Guarded<T & {}, T> & FlowRead<T & {}> = this.nonNullable
}

export type Flowable<T> = T | Flow<T> | FlowRead<T>
export type ExtractFlowable<T> =
  T extends Flow<unknown> ? ReturnType<T["get"]> :
  T extends FlowRead<unknown> ? ReturnType<T["get"]> :
  T

export type FlowRead<T> = AccessorGet<T> & Observable<T>
export type FlowWrite<T> = AccessorSet<T>

export abstract class FlowReadonly<T> {
  protected value: T
  protected messager = new Messager<T>

  constructor(initialValue: T) { this.value = initialValue }

  get() { return this.value }
  protected set(value: T) {
    this.value = value
    this.messager.dispatch(value)
  }

  [Symbol.subscribe](next: (value: T) => void) { return this.messager.subscribe(next) }

  protected toJSON() { return this.value }
}
export abstract class FlowWriteonly<T> {
  protected value: T
  protected messager = new Messager<T>

  constructor(initialValue: T) { this.value = initialValue }

  set(value: T | ((value: T) => T)) {
    value = value instanceof Function ? value(this.value) : value

    this.value = value
    this.messager.dispatch(value)
  }

  protected toJSON() { }
}


// Flow.compute((a, b) => a + b, [new Flow(""), new Flow(1), 1, 2, "", { a: 1 }])
// Flow.all([new Flow(""), new Flow(1)])
// new Flow<{a:1} | null>(null).$.a
// Flow.f`my book: ${new Flow(1)}`

type FlowFlatten<T> = T extends FlowRead<infer U> ? FlowFlatten<U> : T

// Flow.flat(new Flow(new Flow(new Flow(""))))
