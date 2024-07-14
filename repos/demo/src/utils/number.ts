export const humanizeValue = (value: number, metric: string, noDecimal = false) => {
    switch (metric) {
        case "latency": {
            if (value < 0.03) return "<30 ms"
            return value > 1 ? `${value.toFixed(noDecimal ? 1 : 3)} s` : `${(value * 1000).toFixed(0)} ms`
        }
        case "measuredBandwidth":
            return `${(value / 1000).toFixed(noDecimal ? 0 : 2)} Mbps`
        case "stallDuration":
            return value < 1000 ? `${value.toFixed(0)} ms` : `${(value / 1000).toFixed(noDecimal ? 0 : 2)} s`
        case "bitrate":
            return `${(value / 1000).toFixed(0)} Kbps`
        case "skippedDuration":
            return `${value.toFixed(noDecimal ? 0 : 2)} s`
        default:
            return String(value)
    }
}

export const normalizeValue = (value: number, metric: string) => {
    switch (metric) {
        case "latency":
            return value
        case "measuredBandwidth":
            return value * 1000
        case "stallDuration":
            return value
        case "bitrate":
            return value * 1000
        case "skippedDuration":
            return value
        default:
            return value
    }
}
