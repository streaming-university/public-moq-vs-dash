import { SWMA } from "../../moq/common/utils"
import { Catalog } from "../../moq/media/catalog"
import { Player } from "../../moq/playback"
import { SkipEvent } from "../../moq/playback/webcodecs/message"
import type { AggregatorData, AggregatorType, Track } from "../types"
import { Aggregator, BaseAggregatorData } from "./base"

export class MOQAggregator extends Aggregator {
    identifier: AggregatorType = "moq"
    publicState: Record<string, unknown> = {
        abrEnabled: true
    }

    #data: AggregatorData = structuredClone(BaseAggregatorData)
    #player: Player | null = null
    #provisionalPlayer: Promise<Player>

    #measuredBandwidth = new SWMA(5, "moq-bw")
    #measuredBandwidthHistory = [] as { 
        timestamp: string; 
        tc_limit: string;
        mb_tc_ratio: string;
        measured_bandwidth: string;
        bit_rate: string,
    }[]

    #abrConfig = {
        // startup delay is the time we wait before starting ABR using after the first measuredBandwidth event
        startupDelay: 5000, // ms - wait for 5 seconds before starting ABR
        // maxSkipSegmentCountForCongestion is the number of skip events we wait for before switching down
        maxSkipSegmentCountForCongestion: 5,
        // congestionWindow is the time window in which we look for congestion events
        congestionWindow: 5000, // ms
        // coolOffTime is the time we wait after a congestion event before switching up/down
        coolOffTime: 15000, // ms
        // switchUpMultiplier is the multiplier for switching up
        switchUpMultiplier: 2.3,
        // switchDownMultiplier is the multiplier for switching down
        switchDownMultiplier: 1.5,
        // coolOffTimeAfterSwitch is the time we wait after a switch event before switching up/down
        coolOffTimeAfterSwitch: 15000, // ms
        // bwSignalWindow is the time window in which we look for bandwidth change events
        bwSignalWindow: 5000, // ms
        // minBWHighEventsForSwitchUp is the number of bandwidth change events we wait for before switching up
        minBWHighEventsForSwitchUp: 3,
        // minBWLownEventsForSwitchDown is the number of bandwidth change events we wait for before switching down
        minBWLownEventsForSwitchDown: 3
    }

    // initialization time is set when the first measuredBandwidth event is received
    #initializationTime = 0 // ms
    // lastCongestionTime is the time of the last congestion event
    #lastCongestionTime = 0 // ms
    // lastSwitchTime is the time of the last switch event
    #lastSwitchTime = 0 // ms
    // a list of recent events to detect congestion, track bandwidth changes, etc.
    #eventHistory = [] as { time: number; event: string }[]
    // timerEventHistoryCleanup is the timer for cleaning up the event history
    #timerEventHistoryCleanup: number | null = null

    #abrEventCallback: ((newTrack: string) => void) | null = null

    #state: {
        stallDuration: number
        provisionalStallDuration: number
        lastDisplayTime: number
        totalSkipDuration: number
        tracks: Track[]
        latencyTarget: number
        serverTimeOffset: number
    } = {
        stallDuration: 0,
        provisionalStallDuration: 0,
        lastDisplayTime: 0,
        totalSkipDuration: 0,
        tracks: [],
        latencyTarget: 0,
        serverTimeOffset: 0
    }

    constructor(view: HTMLCanvasElement) {
        super()

        // Create a new player instance
        // if there is an endpoint address (host:port) in the querystring, pass it to the player
        // we don't set fingerprint for other domains (we assume, a proper TLS certificate is used)
        let endpoint = /[?&]server=([^&]+)/.exec(location.search)
        if (endpoint) {
            console.log("moq | endpoint", endpoint[1])
            this.#provisionalPlayer = Player.create({
                url: `https://${endpoint[1]}/dev`,
                element: view
            })
        } else {
            this.#provisionalPlayer = Player.create({
                url: `https://${location.hostname}:4443/dev`,
                fingerprint: import.meta.env.DEV ? `https://${location.hostname}:4443/fingerprint` : undefined,
                element: view
            })
        }

        // get timestamp from the time server if available
        endpoint = /[?&]ts_url=([^&]+)/.exec(location.search)
        const ts_url = endpoint ? endpoint[1] : "/ts"
        if (ts_url) {
            const start = performance.now()
            fetch(ts_url).then((res) => res.text()).then((res) => {
                // returns seconds with granularity of milliseconds
                const time = parseFloat(res) * 1000
                if (isNaN(time)) {
                    if (ts_url !== "/ts") 
                        throw new Error("Invalid time server response from " + ts_url)
                    else
                        console.log("moq | No time server response")
                    return
                }
                const rtt = performance.now() - start
                const server_time = time + rtt / 2
                const offset = server_time - Date.now()
                console.log("moq | Server timestamp and rtt", time, rtt, offset, res)
                this.#state.serverTimeOffset = offset
            }).catch ((err) => {
                console.error("moq | Error fetching time server", err)
            });
        }
    }

    async init(callback: (data: AggregatorData) => void): Promise<void> {
        // Resolve provisional player
        this.#player = await this.#provisionalPlayer
        console.log("moq | init", this.#player)

        // Add event listeners
        // Custom event support is not yet implemented in TS
        // so we have to cast to EventListener :(
        this.#player.addEventListener("stat", this.#onStat as EventListener)
        this.#player.addEventListener("track_change", this.#onTrackChange as EventListener)
        this.#player.addEventListener("skip", this.#onSkip as EventListener)

        // Set latency target
        this.#player.setLatencyTarget(this.#state.latencyTarget)
        if (!isNaN(this.#state.serverTimeOffset)) {
            this.#player.setServerTimeOffset(this.#state.serverTimeOffset)
        }
        
        // Start playback
        this.#player.start()

        // Set tracks
        this.#state.tracks = this.getTracks()

        this.#timerEventHistoryCleanup = setInterval(
            () => {
                console.log("event history cleanup", this.#eventHistory.length)
                this.#eventHistory = this.#eventHistory.filter((e) => e.time > Date.now() - Math.max(this.#abrConfig.bwSignalWindow, this.#abrConfig.congestionWindow) * 2)
                console.log("event history cleanup done", this.#eventHistory.length)
            },
            Math.max(this.#abrConfig.bwSignalWindow, this.#abrConfig.congestionWindow) * 2
        )

        // Register data relay in super class
        return super.init(callback)
    }

    async destroy(): Promise<void> {
        if (!this.#player) throw new Error("Player not initialised")

        // Remove event listeners
        this.#player.removeEventListener("stat", this.#onStat as EventListener)
        this.#player.removeEventListener("track_change", this.#onTrackChange as EventListener)
        this.#player.removeEventListener("skip", this.#onSkip as EventListener)

        // Destroy player instance
        await this.#player.close()

        // Reset data
        this.#data = structuredClone(BaseAggregatorData)

        // clear event history cleanup timer
        if (this.#timerEventHistoryCleanup) clearInterval(this.#timerEventHistoryCleanup)

        // Continue with super class
        return super.destroy()
    }

    getTracks(): Track[] {
        if (!this.#player) throw new Error("Player not initialised")
        return this.#player
            .getCatalog()
            .getVideoTracks()
            .map((track) => ({
                id: Catalog.getUniqueTrackId(track),
                sid: track.data_track,
                bitrate: track.bit_rate,
                size: {
                    width: track.width,
                    height: track.height
                }
            }))
    }

    setTrack(id: string): void {
        if (!this.#player) throw new Error("Player not initialised")
        const track = this.#player
            .getCatalog()
            .getVideoTracks()
            .find((track) => Catalog.getUniqueTrackId(track) === id)
        if (!track) throw new Error("Track not found")
        this.#player.selectVideoTrack(track)
    }

    toggleABR(state?: boolean): void {
        if (state === undefined) state = !this.publicState.abrEnabled
        this.publicState.abrEnabled = state
        console.log("moq | ABR", state)
    }

    registerABREvents(callback: (newTrack: string) => void): void {
        if (!this.#player) throw new Error("Player not initialised")
        this.#abrEventCallback = callback
        this.#abrEventCallback(this.getTracks().find((track) => track.bitrate === this.#player?.getCurrentVideoTrack()?.bit_rate)?.id ?? "")
    }

    setLatencyTarget(val: number): void {
        this.#state.latencyTarget = val

        // Set latency target if player is initialised
        if (this.#player) {
            this.#player.setLatencyTarget(val)
        }
    }

    #isCoolOffTimeFinished = () => {
        let isCoolOffTimeFinished = true
        if (this.#lastSwitchTime > this.#lastCongestionTime) {
            // seems that we switched up/down recently
            isCoolOffTimeFinished = this.#lastSwitchTime + this.#abrConfig.coolOffTimeAfterSwitch < Date.now()
        } else {
            // a recent congestion event happened
            isCoolOffTimeFinished = this.#lastCongestionTime + this.#abrConfig.coolOffTime < Date.now()
        }
        return isCoolOffTimeFinished
    }

    #onSkip = (e: CustomEvent) => {
        console.log("moq | Skip event", e.type, e.detail)
        const skipData = e.detail as SkipEvent

        const currentTrack = this.#player?.getCurrentVideoTrack()
        const isABREnabled = this.publicState.abrEnabled && this.#initializationTime > 0 && this.#initializationTime + this.#abrConfig.startupDelay < performance.now()
        const skipEventInTheCurrentTrack =
            ["too_old", "too_slow"].includes(skipData?.type) && currentTrack?.data_track === skipData.skippedGroup.track && skipData.skippedGroup.track === skipData.currentGroup.track

        if (isABREnabled && skipEventInTheCurrentTrack && this.#isCoolOffTimeFinished()) {
            // if we have a skip event in the current track, add it to the list of skip events
            this.#eventHistory.push({ time: Date.now(), event: "skip" })

            // if we have "maxSkipSegmentCountForCongestion" congestion events in a window of N seconds, switch down
            const lastSkipEvents = this.#eventHistory.filter((e) => e.event === "skip" && Date.now() - e.time < this.#abrConfig.congestionWindow)
            const congestionIsLikely = lastSkipEvents.length >= this.#abrConfig.maxSkipSegmentCountForCongestion
            if (congestionIsLikely) {
                console.log("moq | switch down (congestion detected)", lastSkipEvents)
                this.#lastCongestionTime = Date.now()

                document.dispatchEvent(new CustomEvent("congestion", { detail: { time: Date.now() } }))

                const tracks = this.getTracks().filter((track) => track.id !== skipData.skippedGroup.track)
                // sort tracks by bitrate and select the lowest bitrate
                const track = tracks.length > 0 ? tracks.sort((a, b) => (a.bitrate! < b.bitrate! ? -1 : 1))[0] : null

                if (track?.id) {
                    this.setTrack(track.id)
                } else {
                    console.log("moq | no track to switch down to")
                }

                // we reset bandwidth measurement because the last value is not valid anymore
                this.#player?.resetBandwidthMeasurement()
            }
        }

        this.#state.totalSkipDuration += skipData.duration
        this.#data.skippedDuration.history.push({
            time: performance.now() + performance.timeOrigin,
            value: this.#state.totalSkipDuration
        })
    }

    #downloadBWStats = () => {
        const link = document.createElement("a")
        document.body.appendChild(link)

        // download logs
        if (this.#measuredBandwidthHistory.length > 0) {
            const headers = [...this.#data.measuredBandwidth.history.keys()]
            const csvContent = "data:application/vnd.ms-excel;charset=utf-8," + headers.join("\t") + "\n" + this.#measuredBandwidthHistory.map((e) => Object.values(e).join("\t")).join("\n")
            const encodedUri = encodeURI(csvContent)
            link.setAttribute("href", encodedUri)
            link.setAttribute("download", "logs_" + Date.now() + ".xls")
            link.click()
        } else {
            console.log("no logs")
        }

        link.remove()
    }
    

    #onStat = (e: CustomEvent) => {
        if (e.detail.type === "latency") {
            this.#data.latency.history.push({
                time: performance.now() + performance.timeOrigin,
                value: e.detail.value
            })
            this.#player?.setCurrentLatency(parseFloat(e.detail.value) * 1000)
        }

        if (e.detail.type === "measuredBandwidth") {

            const measuredBandwidth = e.detail.value
            // console.log("measuredBandwidth", measuredBandwidth)
            const measuredBandwidth_smoothed = this.#measuredBandwidth.next(measuredBandwidth)
            // console.log("measuredBandwidth smoothed", measuredBandwidth)
            const tc_limit = (parseFloat(localStorage.getItem("tc_bandwidth") || "0") || 0) / 1000000 // Mbps
            
            const historyItem = {
                time: performance.now() + performance.timeOrigin,
                value: measuredBandwidth_smoothed
            }
            this.#data.measuredBandwidth.history.push(historyItem)

            const currentBitrate = (this.#player?.getCurrentVideoTrack().bit_rate || 0) / 1000000 // Mbps

            this.#measuredBandwidthHistory.push({
                timestamp: performance.now().toString(), 
                tc_limit: tc_limit.toFixed(2), 
                mb_tc_ratio: (measuredBandwidth / tc_limit / 1000).toFixed(2),
                measured_bandwidth: (measuredBandwidth / 1000).toFixed(2),
                bit_rate: currentBitrate.toString()}
            )
            
            // TODO: Uncomment the following code to download bandwidth stats
            /*
	    const downloadLogsAfterNMeasurementForSameTCLimit = 5
            if (this.#measuredBandwidthHistory.filter(s => s.tc_limit === tc_limit.toFixed(2)).length === downloadLogsAfterNMeasurementForSameTCLimit) {
                console.log("moq | onStat | downloading logs", tc_limit)
                this.#downloadBWStats()
            }
            */

            // initialization time for the ABR algorithm
            if (this.#initializationTime === 0) this.#initializationTime = performance.now()

            console.log(
                "measuredBandwidth event",
                measuredBandwidth,
                this.#lastCongestionTime + this.#abrConfig.coolOffTime,
                Date.now(),
                this.#lastCongestionTime + this.#abrConfig.coolOffTime > Date.now()
            )

            // if the last congestion event happened more than 5 seconds ago
            // then we do not want to switch up/down
            const isABREnabled = this.publicState.abrEnabled && this.#initializationTime > 0 && this.#initializationTime + this.#abrConfig.startupDelay < performance.now()

            if (this.#isCoolOffTimeFinished() && isABREnabled) {
                const currentTrack = this.#player?.getCurrentVideoTrack()
                const currentTrackBitrate = currentTrack?.bit_rate ?? 0

                if (currentTrackBitrate > 0) {
                    const tracks = this.getTracks()
                    if (measuredBandwidth * 1000 > currentTrackBitrate * this.#abrConfig.switchUpMultiplier) {
                        this.#eventHistory.push({ time: Date.now(), event: "bw-high" })
                        const lastBWHighEvents = this.#eventHistory.filter((e) => e.event === "bw-high" && Date.now() - e.time < this.#abrConfig.bwSignalWindow)

                        const canSwitchUp = lastBWHighEvents.length >= this.#abrConfig.minBWHighEventsForSwitchUp
                        console.log("moq | switch up", canSwitchUp, lastBWHighEvents)
                        if (canSwitchUp) {
                            // switch up
                            // sort by bitrate and select the highest bitrate among the candidates
                            const candidates = tracks.filter(
                                (track) => track.bitrate && track.bitrate * this.#abrConfig.switchUpMultiplier <= measuredBandwidth * 1000 && track.bitrate > currentTrackBitrate
                            )
                            candidates?.length && candidates.sort((a, b) => (a.bitrate! > b.bitrate! ? -1 : 1))
                            const track = candidates.length > 0 ? candidates[0] : null
                            if (track?.id) {
                                console.log("moq | switch up: track bitrate: %d bps | tput: %d Kbps", track.bitrate, measuredBandwidth)
                                this.setTrack(track.id)
                                this.#lastSwitchTime = Date.now()
                            }
                        }
                    } else if (measuredBandwidth * 1000 < currentTrackBitrate * this.#abrConfig.switchDownMultiplier) {
                        this.#eventHistory.push({ time: Date.now(), event: "bw-low" })
                        const lastBWLowEvents = this.#eventHistory.filter((e) => e.event === "bw-low" && Date.now() - e.time < this.#abrConfig.bwSignalWindow)

                        const canSwitchDown = lastBWLowEvents.length >= this.#abrConfig.minBWLownEventsForSwitchDown

                        if (canSwitchDown) {
                            // switch down
                            // sort by bitrate and select the highest bitrate among the candidates
                            const candidates = tracks.filter(
                                (track) => track.bitrate && track.bitrate * this.#abrConfig.switchDownMultiplier <= measuredBandwidth * 1000 && track.bitrate < currentTrackBitrate
                            )
                            candidates?.length && candidates.sort((a, b) => (a.bitrate! > b.bitrate! ? -1 : 1))

                            const track = candidates.length > 0 ? candidates[0] : null
                            if (track?.id) {
                                console.log("moq | switch down: track bitrate: %d bps | measuredBandwidth: %d Kbps", track.bitrate, measuredBandwidth, candidates)
                                this.setTrack(track.id)
                                this.#lastSwitchTime = Date.now()
                            }
                        }
                    }
                }
            }
        }

        if (e.detail.type === "stall") {
            const stall = e.detail.value
            if (this.#state.lastDisplayTime !== stall.since) {
                this.#state.lastDisplayTime = stall.since
                this.#state.stallDuration += this.#state.provisionalStallDuration
                this.#state.provisionalStallDuration = 0
            }
            this.#state.provisionalStallDuration = stall.duration

            this.#data.stallDuration.history.push({
                time: performance.now() + performance.timeOrigin,
                value: this.#state.stallDuration + this.#state.provisionalStallDuration
            })
        }

        // Relay data
        this.updateSnapshot(this.#data)
        this.#data = structuredClone(BaseAggregatorData)
    }

    #onTrackChange = (e: CustomEvent) => {
        console.log("track change event", e.detail.value)
        const trackId = e.detail
        const track: Track | undefined = this.#state.tracks.find((track) => track.sid === trackId)
        if (!track) return
        this.#data.bitrate.history.push({
            time: performance.now() + performance.timeOrigin,
            value: track.bitrate ?? 0
        })
        if (this.#abrEventCallback) this.#abrEventCallback(track.id ?? "")
    }
}
