import type { AggregatorData, AggregatorType, Track } from "../types"
import mergeWith from "lodash/mergeWith"
import { ArrayMerger } from "../../../utils/array"

export const BaseAggregatorData: AggregatorData = {
    latency: {
        history: [],
        invert: true
    },
    measuredBandwidth: {
        history: [],
        invert: false
    },
    stallDuration: {
        history: [],
        invert: true
    },
    bitrate: {
        history: [],
        invert: false
    },
    skippedDuration: {
        history: [],
        invert: true
    }
}

export abstract class Aggregator {
    abstract identifier: AggregatorType
    abstract publicState: Record<string, unknown>

    abstract getTracks(): Track[]
    abstract setTrack(id: string): void
    abstract toggleABR(state?: boolean): void
    abstract registerABREvents(callback: (newTrack: string) => void): void
    abstract setLatencyTarget(val: number): void

    protected snapshot: AggregatorData = structuredClone(BaseAggregatorData)
    private lastValues: AggregatorData = structuredClone(BaseAggregatorData)

    private callback: (data: AggregatorData) => void = () => {}

    private raf: number | null = null
    private sampleTime = 100 // ms
    private lastTime = 0 // ms

    async init(callback: (data: AggregatorData) => void): Promise<void> {
        this.callback = callback
        this.raf = window.requestAnimationFrame(this.relay.bind(this))
        return Promise.resolve()
    }

    async destroy(): Promise<void> {
        if (this.raf) window.cancelAnimationFrame(this.raf)
        return Promise.resolve()
    }

    protected updateSnapshot(data: AggregatorData): void {
        mergeWith(this.snapshot, data, ArrayMerger)
    }

    protected relay() {
        // This is the relay function, where we ensure we send a complete snapshot
        // to the callback function. Because some data might not be updated every
        // frame, we need to fill in the gaps with the last known value.

        // Throttle the relay to 100ms
        if (performance.now() - this.lastTime < this.sampleTime) {
            this.raf = window.requestAnimationFrame(this.relay.bind(this))
            return
        }

        // If we have data for a metric, send it as is. But save the last known to lastValues
        // If we don't have data for a metric, send the last known value from lastValues
        const completeSnapshot: AggregatorData = Object.keys(this.snapshot).reduce((acc, key) => {
            const metric = key as keyof AggregatorData

            if (this.snapshot[metric].history.length > 0) {
                acc[metric] = this.snapshot[metric]
                this.lastValues[metric].history = [this.snapshot[metric].history[this.snapshot[metric].history.length - 1]]
            } else {
                const lastValue = this.lastValues[metric].history.length > 0 ? this.lastValues[metric].history[this.lastValues[metric].history.length - 1].value : 0
                acc[metric].history = [
                    {
                        time: performance.now() + performance.timeOrigin,
                        value: lastValue
                    }
                ]
            }
            return acc
        }, structuredClone(BaseAggregatorData))

        // Send the complete snapshot to the callback
        this.callback(completeSnapshot)
        this.snapshot = structuredClone(BaseAggregatorData)

        this.lastTime = performance.now()
        this.raf = window.requestAnimationFrame(this.relay.bind(this))
    }
}
