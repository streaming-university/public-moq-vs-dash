import { BaseAggregatorData, type Aggregator } from "./aggregator/base"
import type { AggregatorSnapshot, AggregatorType, SynchroniserData, SynchroniserEventData, SynchroniserSnapshot } from "./types"
import mergeWith from "lodash/mergeWith"
import { createContext } from "react"
import { useContext } from "react"
import { ArrayMerger } from "../../utils/array"

export const BaseSynchroniserData: SynchroniserData = {
    moq: structuredClone(BaseAggregatorData),
    dash: structuredClone(BaseAggregatorData)
}

export const BaseSynchroniserSnapshot: SynchroniserSnapshot = {
    snapshot: Object.keys(BaseAggregatorData).reduce((acc, key) => {
        const metric = key as keyof AggregatorSnapshot
        acc[metric] = {
            current: 0,
            ratio: 0
        }
        return acc
    }, {} as AggregatorSnapshot),
    data: structuredClone(BaseAggregatorData)
}

// Metric data context
export const MetricsContext = createContext<SynchroniserSnapshot>(structuredClone(BaseSynchroniserSnapshot))
export const useMetrics = () => useContext(MetricsContext)

export class MetricSynchroniser {
    #data: SynchroniserData = structuredClone(BaseSynchroniserData)
    #aggregator: Aggregator | null = null
    #aggregatorInitialised = false
    #bc: BroadcastChannel
    #comparisonIdentifier: AggregatorType | null = null

    constructor() {
        // Open a BroadcastChannel to receive data from other tabs
        this.#bc = new BroadcastChannel("metrics")
        this.#bc.onmessage = this.#synchronise.bind(this)
    }

    /**
     * Get the current metrics. If a comparison is set, the ratio is calculated.
     * The ratio is the comparison value divided by the current value. Which gives the magnitude of greatness.
     */
    get metrics(): SynchroniserSnapshot {
        if (!this.#aggregator) throw new Error("No aggregator registered")

        const snapshot = Object.entries(this.#data[this.#aggregator.identifier]).reduce((acc, [key, value]) => {
            const metric = key as keyof AggregatorSnapshot
            const currentValue = value.history[value.history.length - 1]?.value ?? 0

            const comparison = this.#comparisonIdentifier ? this.#data[this.#comparisonIdentifier][metric] : null
            const comparisonValue = comparison?.history[comparison.history.length - 1]?.value ?? 0

            let ratio = comparisonValue ? currentValue / comparisonValue : 0

            // Clamp and adjust ratio
            if (comparison) {
                ratio -= 1
                ratio = Math.min(Math.max(ratio, -1), 1)
            }

            // Invert ratio if needed
            if (value.invert) ratio *= -1

            acc[metric] = {
                current: currentValue,
                ratio
            }
            return acc
        }, {} as AggregatorSnapshot)

        // Compare data
        return {
            snapshot,
            data: this.#data[this.#aggregator.identifier]
        }
    }

    get aggregator(): Aggregator | null {
        if (!this.#aggregatorInitialised) {
            console.warn("aggregator is not initialised")
            return null
        }
        return this.#aggregator
    }

    get data(): SynchroniserData {
        return this.#data
    }

    #synchronise({ data }: MessageEvent<SynchroniserEventData>) {
        // Save comparison data
        this.#comparisonIdentifier = data.identifier
        if (this.#aggregator?.identifier === data.identifier) return
        mergeWith(this.#data[data.identifier], data.data, ArrayMerger)
    }

    async register(aggregator: Aggregator) {
        this.#aggregator = aggregator
        await aggregator.init((data) => {
            // Save current data
            mergeWith(this.#data[aggregator.identifier], data, ArrayMerger)

            // Send data to comparison
            this.#bc.postMessage({
                identifier: aggregator.identifier,
                data
            })
        })
        this.#aggregatorInitialised = true
    }

    unregister() {
        if (!this.#aggregator) throw new Error("No aggregator registered")
        this.#aggregator.destroy()
        this.#aggregator = null
        this.#data = structuredClone(BaseSynchroniserData)
    }
}

// MetricSyncroniser context
export const MetricSynchroniserContext = createContext<MetricSynchroniser>(new MetricSynchroniser())
export const useMetricSynchroniser = () => useContext(MetricSynchroniserContext)
