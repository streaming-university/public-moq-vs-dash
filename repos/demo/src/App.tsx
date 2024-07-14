import Metrics from "./components/metrics"
import { DASHPlayer, MOQPlayer } from "./components/players"
import { DASHAggregator, MOQAggregator } from "./lib/internal/aggregator"
import type { PlayerType, Track } from "./lib/internal/types"
import type { ChangeEvent, Ref } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useMetricSynchroniser } from "./lib/internal/synchroniser"
import { useBandwidthSynchroniser } from "./lib/internal/bandwidthSynchroniser"
import clsx from "clsx"

// bandwidth options from 1 Mbps to 10 Mbps and to unlimited
const BANDWIDTH_OPTIONS = [
    { label: "No limit ", value: "unlimited" },
    { label: "1 Mbps", value: "1000000" },
    { label: "1.1 Mbps", value: "1100000" },
    { label: "1.65 Mbps", value: "1650000" },
    { label: "2 Mbps", value: "2000000" },
    { label: "3 Mbps", value: "3000000" },
    { label: "4 Mbps", value: "4000000" },
    { label: "4.5 Mbps", value: "4500000" },
    { label: "5 Mbps", value: "5000000" },
    { label: "6 Mbps", value: "6000000" },
    { label: "6.75 Mbps", value: "6750000" },
    { label: "7 Mbps", value: "7000000" },
    { label: "8 Mbps", value: "8000000" },
    { label: "9 Mbps", value: "9000000" },
    { label: "10 Mbps", value: "10000000" },
    { label: "12 Mbps", value: "12000000" },
    { label: "14 Mbps", value: "14000000" },
    { label: "16 Mbps", value: "16000000" },
    { label: "18 Mbps", value: "18000000" },
    { label: "20 Mbps", value: "20000000" },
    { label: "100 Mbps", value: "100000000" }
]

const LATENCY_TARGETS = [
    { label: "Live edge", value: "0" },
    { label: "1s", value: "1" },
    { label: "2s", value: "2" },
    { label: "3s", value: "3" },
    { label: "4s", value: "4" },
    { label: "5s", value: "5" }
]

const WARMUP_ON_START = false
const ABR_ENABLED_ON_START = true

const INITIAL_BANDWIDTH = localStorage.getItem("tc_bandwidth") || "unlimited"

const DEFAULT_LATENCY_TARGET_DASH = 1.5 // seconds
const DEFAULT_LATENCY_TARGET_MOQ = 0

export default function App({ mode }: { mode: PlayerType }) {
    const ms = useMetricSynchroniser()
    const bandwidthSync = useBandwidthSynchroniser()

    const ref = useRef<HTMLVideoElement | HTMLCanvasElement>(null)

    // Catalog tracks
    const [tracks, setTracks] = useState<Track[]>([])
    const [currentTrack, setCurrentTrack] = useState<string>("")

    const [bandwidth, setBandwidth] = useState<string>("")
    const [statusMessage, setStatusMessage] = useState<string>("")
    const [showStatusMessage, setShowStatusMessage] = useState<boolean>(false)

    const [abrEnabled, setAbrEnabled] = useState<boolean>(ABR_ENABLED_ON_START && (!WARMUP_ON_START || mode === "dash"))
    const [isSyncEnabled, setIsSyncEnabled] = useState(false)

    const [latencyTarget, setLatencyTarget] = useState<number>(mode === "dash" ? DEFAULT_LATENCY_TARGET_DASH : DEFAULT_LATENCY_TARGET_MOQ)

    const [warmingUp, setWarmingUp] = useState<boolean>(WARMUP_ON_START && mode === "moq")

    const ws = useRef<WebSocket | null>(null)

    useEffect(() => {
        const channel = bandwidthSync.channel

        const handleSyncChange = (event: MessageEvent) => {
            const { isSyncEnabled: receivedSyncEnabled } = event.data
            setIsSyncEnabled(receivedSyncEnabled)
        }

        const handleBandwidthChange = (event: MessageEvent) => {
            const { bandwidth: receivedBandwidth } = event.data
            // if sync is enabled, update the bandwidth
            if (bandwidthSync.settings.isSyncEnabled) {
                setBandwidth(receivedBandwidth)
            }
        }

        channel.addEventListener("message", handleSyncChange)
        channel.addEventListener("message", handleBandwidthChange)

        return () => {
            channel.removeEventListener("message", handleSyncChange)
        }
    }, [bandwidthSync])

    useEffect(() => {
        setIsSyncEnabled(bandwidthSync.settings.isSyncEnabled)

        // Apply new bandwidth and update WebSocket server if sync is enabled
        if (bandwidthSync.settings.isSyncEnabled) {
            updateBandwidth(bandwidthSync.settings.bandwidth)
            const newBandwidth = bandwidthSync.settings.bandwidth
            if (newBandwidth === "unlimited") {
                const message = `clear ${mode}`
                ws.current?.send(message)
                setStatusMessage("Bandwidth limit is not applied.")
            } else if (newBandwidth !== "" && !isNaN(parseInt(newBandwidth)) && parseInt(newBandwidth) !== 0) {
                const message = `set ${mode} ${newBandwidth}`
                ws.current?.send(message)
                setStatusMessage(`Bandwidth is limited to ${parseInt(newBandwidth) / 1000000} Mbps`)
            } else {
                console.warn("App | Invalid bandwidth setting:", newBandwidth)
            }
        }
    }, [bandwidthSync.settings])

    useEffect(() => {
        // if status message is changed, set showStatusMessage to true
        // after a timeout of 5 seconds, set showStatusMessage to false
        if (statusMessage) {
            setShowStatusMessage(true)
            setTimeout(() => setShowStatusMessage(false), 5000)
        }
    }, [statusMessage])

    // Read mode from URL
    useEffect(() => {
        console.log("App | initializing app", mode)

        // if there is an endpoint address (host:port) in the querystring
        const m = /[?&]ws_server=([^&]+)/.exec(location.search)
        let endpoint = m ? m[1] : `wss://${location.hostname}:8000`

        // Ensure the endpoint is a valid WebSocket URL
        if (!endpoint.match(/^wss*:\/\//)) {
            setStatusMessage("App | Error: Invalid WebSocket server address.")
            return
        }

        // Upgrade endpoint to secure WebSocket if necessary
        if (location.protocol === "https:" && endpoint.startsWith("ws:")) {
            console.log("App | Upgrading WebSocket server address to secure connection")
            endpoint = endpoint.replace(/^ws:/, "wss:")
        }

        console.log("App | Connecting to WebSocket server:", endpoint)
        ws.current = new WebSocket(endpoint)

        ws.current.onopen = () => {
            console.log("App | WebSocket connection established")
            // update bandwidth to no limit
            setBandwidth(INITIAL_BANDWIDTH)
            updateBandwidth(INITIAL_BANDWIDTH)
        }

        ws.current.onmessage = (event) => {
            console.log("App | WebSocket message received:", event.data)
        }

        ws.current.onerror = (error) => {
            console.error("WebSocket error:", error)
            setStatusMessage("App | Error: Could not connect to WebSocket server.")
        }

        return () => {
            if (ws.current) {
                ws.current.close()
                ws.current = null
            }
        }
    }, [mode])

    // Register synchroniser
    useEffect(() => {
        if (!ref.current) return

        if (mode === "dash") {
            document.title = "LL-DASH | Streaming University"
        } else if (mode === "moq") {
            document.title = "Media-over-QUIC | Streaming University"
        }

        const init = async (view: HTMLVideoElement | HTMLCanvasElement) => {
            switch (mode) {
                case "moq": {
                    const moqAggregator = new MOQAggregator(view as HTMLCanvasElement)
                    moqAggregator.setLatencyTarget(DEFAULT_LATENCY_TARGET_MOQ)
                    await ms.register(moqAggregator)
                    // setting tracks
                    setTracks(moqAggregator.getTracks() || [])
                    moqAggregator.registerABREvents(setCurrentTrack)
                    ms.aggregator?.toggleABR(abrEnabled)

                    // warm-up
                    if (WARMUP_ON_START) relayWarmUp()
                    break
                }
                case "dash": {
                    const dashAggregator = new DASHAggregator(view as HTMLVideoElement)
                    dashAggregator.setLatencyTarget(DEFAULT_LATENCY_TARGET_DASH)
                    await ms.register(dashAggregator)
                    break
                }
            }
        }

        init(ref.current)
            .then(() => console.log("Registered"))
            .catch((err) => console.error("Failed to register", err))

        return () => ms.unregister()
    }, [mode])

    const onTrackChange = (e: ChangeEvent<HTMLSelectElement>) => {
        if ((e.target! as HTMLSelectElement).value === "") return
        ms.aggregator?.setTrack((e.target! as HTMLSelectElement).value)
    }
    const onBandwidthChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const newBandwidth = e.target.value
        if (newBandwidth !== "") {
            // Update the bandwidth without changing the sync state
            setBandwidth(newBandwidth)
            bandwidthSync.updateSettings(newBandwidth, bandwidthSync.settings.isSyncEnabled)
            updateBandwidth(newBandwidth)
        }
    }

    const updateBandwidth = useCallback(
        (newBandwidth: string) => {
            bandwidthSync.updateSettings(newBandwidth, bandwidthSync.settings.isSyncEnabled)

            if (!ws.current) return

            if (ws.current.readyState === WebSocket.OPEN) {
                if (newBandwidth === "unlimited") {
                    const message = `clear ${mode}`
                    ws.current.send(message)
                    setStatusMessage("Bandwidth limit is not applied.")
                    localStorage.removeItem("tc_bandwidth")
                } else {
                    const message = `set ${mode} ${newBandwidth}`
                    ws.current.send(message)
                    const readableBandwidth = BANDWIDTH_OPTIONS.find((option) => option.value === newBandwidth)?.label || "unlimited"
                    // set this bandwidth to local storage
                    localStorage.setItem("tc_bandwidth", newBandwidth)
                    setStatusMessage(`Bandwidth is limited to ${readableBandwidth}`)
                }
            }
        },
        [bandwidthSync, mode]
    )

    const onSyncChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newIsSyncEnabled = e.target.checked
        setIsSyncEnabled(newIsSyncEnabled)
        bandwidthSync.updateSettings(bandwidthSync.settings.bandwidth, newIsSyncEnabled)
    }

    const toggleAbr = () => {
        setAbrEnabled(!abrEnabled)
        ms.aggregator!.toggleABR(!abrEnabled)
    }

    const relayWarmUp = () => {
        console.log("App | Starting warm-up")
        const warmUpInterval = 1000
        // change tracks one by one with 5 seconds interval
        const tracks = ms.aggregator?.getTracks() || []
        const trackIds = tracks.map((track) => track.id)
        let i = 0
        const interval = setInterval(() => {
            if (i >= trackIds.length) {
                clearInterval(interval)
                return
            }
            console.log("App | Setting track:", trackIds[i])
            ms.aggregator?.setTrack(trackIds[i]!)
            i++
        }, warmUpInterval)
        // after warm-up is complete, set ABR to true
        if (warmingUp) {
            setTimeout(
                () => {
                    console.log("App | Setting ABR to true")
                    setAbrEnabled(true)
                    setWarmingUp(false)
                    ms.aggregator?.toggleABR(true)
                },
                warmUpInterval * trackIds.length + 2000
            )
        }
        setTimeout(
            () => {
                console.log("App | Setting ABR to true")
                setAbrEnabled(true)
                setWarmingUp(false)
                ms.aggregator?.toggleABR(true)
            },
            warmUpInterval * trackIds.length + 2000
        )
    }

    const onLatencyTargetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        if (e.target.value === "") return
        const latency = parseInt(e.target.value)
        console.log("App | Setting latency target:", latency)
        setLatencyTarget(latency)
        ms.aggregator?.setLatencyTarget(latency)
    }

    // For testing purposes, change the bandwidth every 10 seconds
    const bandwidthChanger = (newBandwidth: number, direction: "up" | "down" = "down") => {
        console.log("App | Changing bandwidth to", newBandwidth, direction)
        const ddl = document.getElementById("ddlBandwidth") as HTMLSelectElement
        ddl.value = newBandwidth.toString()
        updateBandwidth(newBandwidth.toString())

        if (newBandwidth === 20000000 && direction === "up") {
            return
        }

        if (newBandwidth === 2000000 && direction === "down") {
            // direction = "up"
            return
        }
        
        if (direction === "up") {
            newBandwidth += 2000000
        } else {
            newBandwidth -= 2000000
        }
        setTimeout(() => {
            bandwidthChanger(newBandwidth, direction)
        }, 10000);
        
    }

    return (
        <main className="flex h-dvh w-screen flex-col items-center gap-4">
            <header className="mt-4 flex w-full max-w-7xl flex-col items-center justify-between gap-2 px-4">
                <h1 className={clsx(mode === "moq" ? "text-moq" : "text-dash", "text-3xl md:text-5xl xl:text-7xl")}>{mode === "moq" ? "Media-over-QUIC" : "LL-DASH"}</h1>
                <div className="flex flex-col text-center text-white md:flex-row md:gap-2 lg:text-xl xl:text-2xl">
                    {mode === "moq" &&  
                        <>
                            <span>This project is part of</span>
                            <a className="text-blue-400 underline" href="https://streaming.university">
                                Streaming University
                            </a> (<a href="https://github.com/streaming-university/public-moq-vs-dash" target="_blank">Source code</a>)
                        </>
                    }
                    {mode === "dash" && <span>Powered by <a href="https://dashjs.org/" target="_blank">dash.js</a>.</span>}
                </div>
            </header>
            <section className="container mx-auto flex max-w-2xl flex-col items-center gap-4 px-4">
                {mode === "dash" && <DASHPlayer ref={ref as Ref<HTMLVideoElement>} muted />}
                {mode === "moq" && <MOQPlayer ref={ref as Ref<HTMLCanvasElement>} />}
                <div className="flex w-full items-center justify-center">
                    {warmingUp && <span>Initializing...</span>}
                    {!warmingUp && (
                        <table className="w-full table-fixed text-center text-white">
                            <tbody>
                                <tr>
                                    <td>
                                        <select onChange={onTrackChange} value={currentTrack} className="w-full bg-white text-black" disabled={mode === "dash"}>
                                            <option value="">Select track</option>
                                            {tracks?.length > 0 &&
                                                tracks.map((track) => (
                                                    <option key={track.id} value={track.id}>
                                                        {track.size.width}x{track.size.height} @ {(track.bitrate || 0) / 1000}kbps
                                                    </option>
                                                ))}
                                        </select>
                                    </td>
                                    <td className="flex justify-center gap-2">
                                        <label htmlFor="syncCheckbox">Sync</label> <span className="text-xs cursor-pointer" title={"When you select this, it synchronizes bandwidth limit with the " + (mode === "moq" ? "LL-DASH" : "MOQ") + " player."}>(?)</span>
                                        <input type="checkbox" id="syncCheckbox" checked={isSyncEnabled} onChange={onSyncChange} />
                                    </td>
                                </tr>
                                <tr>
                                    <td>
                                        <select onChange={onBandwidthChange} value={bandwidthSync.settings.bandwidth} className="w-full bg-white text-black">
                                            <option value="">Limit bandwidth</option>
                                            {BANDWIDTH_OPTIONS.map((option) => (
                                                <option key={option.value} value={option.value}>
                                                    {option.label}
                                                </option>
                                            ))}
                                        </select>
                                    </td>
                                    <td className="flex justify-center gap-2">
                                        <label>ABR</label>
                                        <input type="checkbox" checked={abrEnabled} onChange={toggleAbr} disabled={mode === "dash"} />
                                    </td>
                                </tr>
                                <tr>
                                    <td>
                                        <select onChange={onLatencyTargetChange} value={latencyTarget} className="w-full bg-white text-black">
                                            {LATENCY_TARGETS.map((option) => (
                                                <option key={option.label} value={option.value}>
                                                    {option.label}
                                                </option>
                                            ))}
                                        </select>
                                    </td>
                                    <td></td>
                                </tr>
                            </tbody>
                        </table>
                    )}
                </div>
                <div className={clsx("text-center text-white transition-all duration-150", showStatusMessage ? "opacity-100" : "opacity-0")}>{statusMessage}</div>
            </section>
            <section className="flex w-full grow flex-col justify-center gap-3 md:flex-row md:gap-10">{...Metrics}</section>
        </main>
    )
}
