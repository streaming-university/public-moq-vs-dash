import { useMetrics } from "../../lib/internal/synchroniser"
import type { AggregatorData } from "../../lib/internal/types"
import { convertCamelCase } from "../../utils/text"
import { humanizeValue } from "../../utils/number"

export default function BaseMetric({ metric }: { metric: keyof AggregatorData }) {
    // Metric related state
    const metrics = useMetrics()
    const { snapshot, data } = metrics
    const { current } = snapshot[metric]
    const recentHistory = data[metric].history.slice(-3)
    const invert = data[metric].invert

    // Decide on diff color
    let diffColor = "rgb(245, 245, 245)"
    if (recentHistory.length > 1) {
        let upTrend = null
        // If last values have decending trend, color red
        if (recentHistory.slice(1).every(({ value }, index) => value < recentHistory[index].value)) {
            upTrend = false
        } else if (recentHistory.slice(1).every(({ value }, index) => value > recentHistory[index].value)) {
            upTrend = true
        }

        if (upTrend !== null) {
            if (invert) upTrend = !upTrend
            diffColor = upTrend ? "rgb(0, 255, 0)" : "rgb(255, 0, 0)"
        }
    }

    // Humanize value
    const humanizedValue = humanizeValue(current, metric).split(" ")
    let value = humanizedValue[0]
    const unit = humanizedValue[1]

    // Special handling for latency
    if (metric === "latency" && Number(value) < 30 && unit === "ms") value = "<30"

    return (
        <div className="flex flex-row items-stretch gap-4 md:flex-col md:gap-0 lg:text-xl xl:text-2xl max-md:[&>*]:flex-[1]">
            <span className="text-center text-neutral-100">{convertCamelCase(metric)}</span>
            <div className="table table-fixed">
                <pre className="table-cell pr-1 text-end transition-colors duration-150" style={{ color: diffColor }}>
                    {value.padStart(3, " ")}
                </pre>
                <span className="table-cell pl-1 text-start font-bold text-white">{unit}</span>
            </div>
        </div>
    )
}
