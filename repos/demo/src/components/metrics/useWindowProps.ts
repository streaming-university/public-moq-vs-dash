import { useEffect, useMemo, useState } from "react"

const WINDOW_ID = Math.random().toString(36).slice(2)

export default function useWindowProps(metric: string) {
    const bc = useMemo(() => new BroadcastChannel("window-props"), [])
    const [leftAligned, setLeftAligned] = useState(true)
    const [metricOpen, setMetricOpen] = useState(false)

    useEffect(() => {
        const onMouseOut = () => bc.postMessage({ id: WINDOW_ID, event: "window", screenLeft: window.screenLeft })
        window.addEventListener("mouseout", onMouseOut)
        return () => window.removeEventListener("mouseout", onMouseOut)
    }, [])

    useEffect(() => {
        const onMessage = ({ data }: MessageEvent) => {
            if (data.id !== WINDOW_ID && data.event === "window") setLeftAligned(data.screenLeft >= window.screenLeft)
            if (data.event === "metric") setMetricOpen(data.metric === metric && data.open)
        }
        bc.addEventListener("message", onMessage)
        return () => bc.removeEventListener("message", onMessage)
    }, [])

    const setOpen = (open: boolean) => {
        setMetricOpen(open)
        bc.postMessage({ id: WINDOW_ID, event: "metric", metric, open })
    }

    return { leftAligned, metricOpen, setOpen }
}
