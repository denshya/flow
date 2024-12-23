import { Messager } from "./Messages"
import { Signal } from "./Signal"
import { AccessorSet, AccessorGet, Guarded, Observable, Unsubscribe } from "./types"


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
        if (values[index] === value) return

        values[index] = value
        computed.set(predicate(...values as never))
      })
    })

    return computed
  }

  static computeRecord<T extends Record<keyof never, unknown>>(record: T): Flow<{ [K in keyof T]: ExtractFlowable<T[K]> }> {
    const object = {} as any
    const flow = new Flow(object)

    for (const [key, value] of Object.entries(object)) {
      const valueFlow = Flow.from(value)

      object[key] = valueFlow.get()
      valueFlow[Symbol.subscribe](it => object[key] = it)
    }

    return flow as never
  }

  static get<T>(value: Flowable<T>): T {
    if (value instanceof Object === false) return value
    if ("get" in value === false) return value
    if (Symbol.subscribe in value === false) return value

    return value.get()
  }

  static for<Args extends unknown[], Return>(fn: (...args: Args) => Return): (...args: { [K in keyof Args]: Flowable<Args[K]> }) => FlowRead<Return> {
    return (...args) => Flow.compute(fn, args as never).readonly()
  }


  sets<U>(other: AccessorSet<T | U>): Unsubscribe
  sets(callback: (value: T) => void): Unsubscribe
  sets<U>(arg: AccessorSet<T | U> | ((value: T) => void)): Unsubscribe {
    const set = arg instanceof Function ? arg : arg.set

    return this[Symbol.subscribe](value => set(value))
  }
  copy(other: AccessorGet<T>) { this.set(other.get()) }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly $ProxyCache: Partial<Record<keyof T, unknown>> = {}
  readonly $ = new Proxy(this, {
    get: (target, key) => {
      const cached = this.$ProxyCache[key as keyof T]
      if (cached != null) return cached

      const property = target.value[key as keyof T]
      if (property instanceof Function) {
        const method = (...args: unknown[]) => {
          const result = property.apply(target.value, args)
          // Method resulting with itself usually means it was updated.
          if (result === target.value) {
            target.messager.dispatch(target.value)
            return target
          }

          const predicate = (value: T) => property.apply(value, args)
          const fork = new Flow(result)
          // Follows `this.to` method implementation from here.
          this[Symbol.subscribe](value => {
            const newValue = predicate(value)
            newValue !== fork.value && fork.set(newValue)
          })
          return fork
        }
        this.$ProxyCache[key as keyof T] = method

        return method
      }

      const propertyFlow = target.to(value => value[key as keyof T])
      this.$ProxyCache[key as keyof T] = propertyFlow

      return propertyFlow
    }
  }) as unknown as { [K in keyof T]-?: T[K] extends (...args: infer Args) => infer Return ? (...args: Args) => Flow<Return> : Flow<T[K]> }

  get it() { return this.value }
  set it(value: T) { this.set(value) }

  to<U>(predicate: (value: T) => U): Flow<U> {
    const fork = new Flow(predicate(this.value))
    this[Symbol.subscribe](value => {
      const newValue = predicate(value)
      newValue !== fork.value && fork.set(newValue)
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
  private value: T
  private messager = new Messager<T>

  constructor(initialValue: T) { this.value = initialValue }

  get() { return this.value }
  protected set(value: T) {
    this.value = value
    this.messager.dispatch(value)
  }
  [Symbol.subscribe](next: (value: T) => void) { return this.messager.subscribe(next) }
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
}


// Flow.compute((a, b) => a + b, [new Flow(""), new Flow(1), 1, 2, "", { a: 1 }])
// Flow.all([new Flow(""), new Flow(1)])
