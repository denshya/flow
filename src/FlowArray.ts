import { Flow, Flowable } from "./Flow"
import { Signal } from "./Signal"
import { isObservableLike, subscribe } from "./utils"


export class FlowArray<T> extends Signal<T[]> implements Iterable<T> {
  constructor(init?: Flowable<T[]>) {
    if (isObservableLike(init)) {
      super(init.get())
      subscribe(init, value => this.set(value))
    } else {
      super(init ?? [])
    }
  }

  at(index: Flowable<number>): Flow<T> {
    const indexFlow = new Flow(this.value[Flow.get(index)])

    if (isObservableLike(index)) subscribe(index, i => indexFlow.set(this.value[i]))
    this[Symbol.subscribe](value => indexFlow.set(value[Flow.get(index)]))

    return indexFlow
  }

  push(value: T): number {
    const index = this.value.push(value)
    this.messager.dispatch(this.value)

    return index
  }

  map<U>(predicate: (value: T, index: number, array: T[]) => U): FlowArray<U> {
    const mapped = new FlowArray(this.value.map(predicate))
    this[Symbol.subscribe](value => mapped.set(value.map(predicate)))
    return mapped
  }

  delete(index: number) {
    this.value.splice(index, 1)
    this.messager.dispatch(this.value)
  }

  *[Symbol.iterator]() { yield* this.value }
}
