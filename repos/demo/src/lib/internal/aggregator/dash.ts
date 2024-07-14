import { Aggregator, BaseAggregatorData } from "./base"
import dashjs, { MediaPlayer, LogLevel } from "dashjs"
import type { AggregatorData, AggregatorType, Track } from "../types"
import type { MediaPlayerClass, BufferStateChangedEvent, Event, QualityChangeRenderedEvent } from "dashjs"
import { SWMA } from "../../moq/common/utils"

class TPHistory {
    #parts: {
        [partName: string]: PerformanceResourceTiming[]
    }
    #swma = new SWMA(7, "dash-tput")

    constructor() {
        this.#parts = {}
    }

    addPart(part: PerformanceResourceTiming): void {
        const name = part.name.split("/").pop() as string
        if (!this.#parts[name]) this.#parts[name] = []
        this.#parts[name].push(part)

        if (this.#hasCompletedParts()) this.#calc()
    }

    getMeasuredBandwidth(): number {
        return this.#swma.next()
    }

    #hasCompletedParts(): boolean {
        return Object.values(this.#parts).some((part) => part.length === 2)
    }

    #calc() {
        // Get completed parts
        const completedParts = Object.fromEntries(Object.entries(this.#parts).filter(([, part]) => part.length === 2))
        this.#parts = Object.fromEntries(Object.entries(this.#parts).filter(([, part]) => part.length < 2))

        for (const bundle of Object.values(completedParts)) {
            // Calculate total size and time
            const totalSize = bundle.reduce((acc, part) => acc + part.transferSize, 0) / 1000 // kbit
            let totalTime = Math.max(bundle[0].responseEnd, bundle[1].responseEnd) - Math.min(bundle[0].responseStart, bundle[1].responseStart)
            totalTime /= 1000 // s

            if (totalSize < 1000) continue
            this.#swma.next(totalSize / totalTime)
        }
    }
}

export class DASHAggregator extends Aggregator {
    identifier: AggregatorType = "dash"
    publicState: Record<string, unknown> = {}

    #data: AggregatorData = structuredClone(BaseAggregatorData)
    #player: MediaPlayerClass

    #state = {
        raf: -1,
        lastBufferStalled: 0, // ms
        lastBufferStallDuration: 0, // ms
        bufferState: "bufferLoaded" as BufferStateChangedEvent["state"],
        lastSeekTime: -1, // ms
        lastSkippedDuration: 0, // ms
        bwHistory: new TPHistory()
    }

    constructor(view: HTMLVideoElement) {
        super()

        // Create a new player instance
        this.#player = MediaPlayer().create()
        this.#player.initialize()

        // Apply settings
        this.#player.updateSettings({
            streaming: {
                buffer: {
                    stallThreshold: 0.05
                },
                delay: {
                    liveDelay: 1.5
                },
                liveCatchup: {
                    maxDrift: 0.1,
                    enabled: true
                }
            },
            debug: {
                logLevel: dashjs.LogLevel.LOG_LEVEL_DEBUG
            }
        })

        // Attach player to video element
        this.#player.attachView(view)
    }

    async init(callback: (data: AggregatorData) => void): Promise<void> {
        // Add event listeners
        this.#player.on("bufferStateChanged", this.#onBufferStateChanged.bind(this))
        this.#player.on("qualityChangeRendered", this.#onQualityChangeRendered.bind(this))
        this.#player.on("playbackSeeking", this.#onPlaybackSeek.bind(this))
        this.#player.on("playbackSeeked", this.#onPlaybackSeek.bind(this))

        // Attach source
        // if there is an endpoint address (host:port) in the querystring, pass it to the player
        const m = /[?&]server=([^&]+)/.exec(location.search)
        let endpoint = m ? m[1] : `${location.hostname}:8080`
        if (!/^https?:\/\//.test(endpoint)) {
            endpoint = location.protocol + "//" + endpoint
        }
        this.#player.attachSource(endpoint + "/live/live.mpd")

        // Start observing
        this.#state.raf = window.requestAnimationFrame(this.#onAnimationFrame.bind(this))

        // Register data relay in super class
        return super.init(callback)
    }

    async destroy(): Promise<void> {
        // Remove event listeners
        this.#player.off("bufferStateChanged", this.#onBufferStateChanged)
        this.#player.off("qualityChangeRendered", this.#onQualityChangeRendered)
        this.#player.off("playbackSeeking", this.#onPlaybackSeek)
        this.#player.off("playbackSeeked", this.#onPlaybackSeek)

        // Stop observing
        window.cancelAnimationFrame(this.#state.raf)

        // Destroy player instance
        this.#player.reset()

        // Reset data
        this.#data = structuredClone(BaseAggregatorData)

        // Continue with super class
        return super.destroy()
    }

    getTracks(): Track[] {
        console.error("Track selection not implemented for DASH")
        return []
    }

    setTrack(_id: string): void {
        console.error("Track selection not implemented for DASH")
    }

    toggleABR(_state?: boolean): void {
        console.error("ABR not implemented for DASH")
    }

    registerABREvents(_callback: (newTrack: string) => void): void {
        console.error("ABR not implemented for DASH")
    }

    setLatencyTarget(val: number): void {
        const currentSettings = { ...this.#player.getSettings() }
        if (!currentSettings.streaming) currentSettings.streaming = {}
        if (!currentSettings.streaming.delay) currentSettings.streaming.delay = {}
        currentSettings.streaming.delay.liveDelay = val
        this.#player.updateSettings(currentSettings)
    }

    #onAnimationFrame(): void {
        this.#data.latency.history.push({
            time: performance.now() + performance.timeOrigin,
            value: this.#player.getCurrentLiveLatency()
        })

        if (this.#state.bufferState === "bufferStalled") {
            this.#state.lastBufferStallDuration += performance.now() - this.#state.lastBufferStalled
            this.#state.lastBufferStalled = performance.now()
        }

        this.#data.stallDuration.history.push({
            time: performance.now() + performance.timeOrigin,
            value: this.#state.lastBufferStallDuration
        })

        const bw = this.#player.getAverageThroughput("video")
        if (bw > 0) {
            this.#data.measuredBandwidth.history.push({
                time: performance.now() + performance.timeOrigin,
                value: bw
            })
        }

        // Relay data
        this.updateSnapshot(this.#data)
        this.#data = structuredClone(BaseAggregatorData)

        // Request next frame
        this.#state.raf = window.requestAnimationFrame(this.#onAnimationFrame.bind(this))
    }

    #onBufferStateChanged(e: Event): void {
        const event = e as BufferStateChangedEvent
        if (event.state === "bufferStalled") this.#state.lastBufferStalled = performance.now()
        this.#state.bufferState = event.state
    }

    #onQualityChangeRendered(e: Event): void {
        const event = e as QualityChangeRenderedEvent
        const bitrates = this.#player.getBitrateInfoListFor("video")

        const oldQuality = event.oldQuality
        const newQuality = this.#player.getQualityFor("video")

        if (!isNaN(oldQuality))
            this.#data.bitrate.history.push({
                time: performance.now() + performance.timeOrigin,
                value: bitrates[oldQuality].bitrate
            })

        if (!isNaN(newQuality))
            this.#data.bitrate.history.push({
                time: performance.now() + performance.timeOrigin,
                value: bitrates[newQuality].bitrate
            })
    }

    #onPlaybackSeek(event: Event) {
        const time = this.#player.timeAsUTC()
        if (event.type === "playbackSeeking") this.#state.lastSeekTime = time
        else if (event.type === "playbackSeeked") {
            if (this.#state.lastSeekTime === -1) return
            this.#state.lastSkippedDuration += time - this.#state.lastSeekTime
            this.#data.skippedDuration.history.push({
                time: performance.now() + performance.timeOrigin,
                value: this.#state.lastSkippedDuration
            })
        }
    }
}
