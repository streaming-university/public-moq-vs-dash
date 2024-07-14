import { createContext, useContext, useEffect, useRef, useState } from "react"
import { BaseSynchroniserData, useMetricSynchroniser } from "./lib/internal/synchroniser"
import { AggregatorData, SynchroniserData } from "./lib/internal/types"
import { useRafLoop, useWindowSize } from "react-use"
import * as Plot from "@observablehq/plot"
import { convertCamelCase } from "./utils/text"
import { merge } from "lodash"
import { humanizeValue } from "./utils/number"

// We might want to use metric specific data in the future
const metricSpecificOptions: Partial<Record<keyof AggregatorData, Partial<Plot.PlotOptions>>> = {
    latency: {
        marginLeft: 50,
        y: {
            tickFormat: (d: number) => humanizeValue(d, "latency", true)
        }
    },
    bitrate: {
        marginLeft: 60,
        y: {
            tickFormat: (d: number) => humanizeValue(d, "bitrate", true)
        }
    },
    stallDuration: {
        y: {
            tickFormat: (d: number) => humanizeValue(d, "stallDuration", true)
        }
    },
    measuredBandwidth: {
        marginLeft: 60,
        y: {
            tickFormat: (d: number) => humanizeValue(d, "measuredBandwidth", true)
        }
    }
}

/**
 * latency: moq ve dash line chart (ayri ayri)
 * measuredBandwidth: moq, tc ve dash line
 * stallDuration: moq ve dash line
 * bitrate: moq ve dash line
 * skippedDuration: moq ve dash line
 *
 * zoom in/out
 * scroll
 */

const MetricContext = createContext<SynchroniserData>(BaseSynchroniserData)
const useMetric = () => useContext(MetricContext)

const MetricChart = () => {
    const ref = useRef<HTMLDivElement>(null)
    const [metricKey, setMetricKey] = useState<keyof AggregatorData>("latency")
    const metric = useMetric()
    const { width, height } = useWindowSize()

    useEffect(() => {
        // Get the data
        const { moq, dash } = metric

        // use only last 10 seconds
        const dashInterpolated = dash[metricKey].history.filter((d) => d.time > performance.now() + performance.timeOrigin - 10000)
        const moqInterpolated = moq[metricKey].history.filter((d) => d.time > performance.now() + performance.timeOrigin - 10000)

        // flatten both
        const data = [...dashInterpolated.map((d) => ({ ...d, symbol: "dash" })), ...moqInterpolated.map((d) => ({ ...d, symbol: "moq" }))]

        // Form the chart
        const chart = Plot.plot(
            merge(metricSpecificOptions[metricKey], {
                width: width / 2,
                height: height / 2 - 24 - 32, // hacky, removes padding and select height
                inset: 20,
                x: {
                    label: "Time",
                    grid: true,
                    tickFormat: (d: number) => {
                        const date = new Date(d)
                        return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
                    }
                },
                y: {
                    grid: true
                },
                color: {
                    domain: ["moq", "dash"],
                    range: ["rgb(214, 102, 41)", "rgb(40, 95, 233)"]
                },
                marks: [
                    Plot.lineY(data, {
                        x: "time",
                        y: "value",
                        stroke: "symbol"
                    }),
                    Plot.text(
                        data,
                        Plot.selectLast({
                            x: "time",
                            y: "value",
                            text: "symbol",
                            dx: 5,
                            dy: -5,
                            fill: "symbol"
                        })
                    )
                ]
            } as Plot.PlotOptions)
        )

        // Attach the chart to the DOM
        ref.current?.append(chart)
        return () => chart.remove()
    }, [metric, metricKey, width, height])

    return (
        <div className="flex flex-col items-start p-4">
            <select onChange={(e) => setMetricKey(e.target.value as keyof AggregatorData)}>
                {Object.keys(metric.moq).map((key) => (
                    <option key={key} value={key}>
                        {convertCamelCase(key)}
                    </option>
                ))}
            </select>
            <div ref={ref} />
        </div>
    )
}

export default function Cockpit() {
    const metrics = useMetricSynchroniser()

    // Render loop
    const [data, setData] = useState<SynchroniserData>(BaseSynchroniserData)
    useRafLoop(() => setData(Object.assign({}, metrics.data)), true)

    return (
        <MetricContext.Provider value={data}>
            <div className="grid h-screen w-screen grid-cols-2 divide-x-2 divide-y-2">
                <MetricChart />
                <MetricChart />
                <MetricChart />
                <MetricChart />
            </div>
        </MetricContext.Provider>
    )
}
