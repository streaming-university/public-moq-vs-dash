import * as Message from "./webcodecs/message"

import { Connection } from "../transport/connection"
import { Catalog, isAudioTrack, isMp4Track, Mp4Track, VideoTrack, AudioTrack } from "../media/catalog"
import { asError } from "../common/error"

// We support two different playback implementations:
import Webcodecs from "./webcodecs"
import MSE from "./mse"
import { Client } from "../transport/client"
import { SubscribeSend } from "../transport"
import { TrackBuffer } from "./trackBuffer"
import { SWMA, TPEstimator } from "../common/utils"

export type Range = Message.Range
export type Timeline = Message.Timeline

async function readStream(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
        const { done, value } = await reader.read()
        if (done) {
            break
        }
        if (value) {
            chunks.push(value)
        }
    }
    const res = chunks.flatMap((a) => Array.from(a))
    return new Uint8Array(res)
}

function arrayToReadableStream(array: Uint8Array) {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(array)
            controller.close()
        }
    })
}

export interface PlayerConfig {
    url: string
    fingerprint?: string // URL to fetch TLS certificate fingerprint
    element: HTMLCanvasElement
}

// This class must be created on the main thread due to AudioContext.
export class Player extends EventTarget {
    #backend: Webcodecs

    // A periodically updated timeline
    //#timeline = new Watch<Timeline | undefined>(undefined)

    #connection: Connection
    #catalog: Catalog

    #currentTracks: Map<string, Mp4Track> = new Map<string, Mp4Track>()

    // For a single track, there are two subscriptions (init_track and data_track)
    #currentSubscriptions: Map<string, SubscribeSend> = new Map<string, SubscribeSend>()

    #runningTrackThreads: Map<string, Promise<void>> = new Map<string, Promise<void>>()
    #nextVideoTrack: Mp4Track | undefined

    // probing settings
    #useProbing: boolean = false
    #probeInterval: number = 2000
    #probeSize: number = 40000
    #probePriority: number = 0 // 0 is lowest priority, 1 is highest
    #probeTimer: number = 0
    #useProbeTestData = false
    #probeTestResults: any[] = []
    #probeTestData = {
        start: 10000,
        stop: 300000,
        increment: 10000,
        iteration: 3,
        lastIteration: 0
    }

    #trackBuffers = new Map<string, TrackBuffer>()
    #latencyTarget = 3000 // default is 3000 ms

    #measuredBandwidth = new SWMA(2, "moq-bw")

    #currentLatency: number | undefined
    #bufferInitialized = false

    // if this is true, the switchTrackId is set as 0
    #enableSwitchTrackIdFeature = this.getFromQueryString("enableSwitchTrackIdFeature", "false") === "true"

    private static GROUP_DURATION: number = 1000 // milliseconds

    // Running is a promise that resolves when the player is closed.
    // #close is called with no error, while #abort is called with an error.
    #running: Promise<void> = Promise.resolve()
    #close!: () => void
    #abort!: (err: Error) => void

    private constructor(connection: Connection, catalog: Catalog, backend: Webcodecs) {
        super()
        this.#connection = connection
        this.#catalog = catalog
        this.#backend = backend

        if (this.#backend instanceof Webcodecs) {
            this.#backend.on(this.#onMessage)
        }
    }

    getFromQueryString(key: string, defaultValue: string = ""): string {
        const re = new RegExp("[?&]" + key + "=([^&]+)")
        const m = re.exec(location.search)
        console.log("playback | getFromQueryString", re, m)
        if (m && m[1]) {
            return m[1]
        }
        return defaultValue
    }

    parseProbeParametersAndRun() {
        try {
            if (!location.search) return

            const probeSize = parseInt(this.getFromQueryString("probeSize", "0"))
            const probePriority = parseInt(this.getFromQueryString("probePriority", "-1"))
            const probeInterval = parseInt(this.getFromQueryString("probeInterval", "0"))

            let useProbing = false
            if (probeSize > 0) {
                useProbing = true
                this.#probeSize = probeSize
            }
            if (probePriority > -1) {
                useProbing = true
                this.#probePriority = probePriority
            }
            // set probeInterval and start probeTimer
            if (probeInterval > 0 && probeInterval !== this.#probeInterval) {
                useProbing = true
                if (this.#probeTimer) {
                    clearInterval(this.#probeTimer)
                }
                this.#probeInterval = probeInterval
                this.#probeTimer = setInterval(this.runProbe, this.#probeInterval)
            }

            if (useProbing) {
                this.#useProbing = true
                console.log("playback | parseProbeParameters | probeSize: %d probePriority: %d probeInterval: %d", this.#probeSize, this.#probePriority, this.#probeInterval)
            }
        } catch (e) {
            console.error("playback | parseProbeParameters | error", e)
        }
    }

    start() {
        const abort = new Promise<void>((resolve, reject) => {
            this.#close = resolve
            this.#abort = reject
        })

        // Async work
        this.#running = Promise.race([this.#run(), abort]).catch(this.#close)

        // Wait for the player to start before probing
        this.parseProbeParametersAndRun()

        window.onhashchange = () => {
            this.parseProbeParametersAndRun()
        }

        // if probing didn't start, start it
        if (this.#useProbing && !this.#probeTimer) {
            this.#probeTimer = setInterval(this.runProbe, this.#probeInterval)
        }
    }

    static async create(config: PlayerConfig): Promise<Player> {
        const client = new Client({
            url: config.url,
            fingerprint: config.fingerprint,
            role: "subscriber"
        })
        const connection = await client.connect()

        console.log("playback | connected")

        const catalog = await Catalog.fetch(connection)

        console.log("Plaplaybackyer | fetched the catalog", catalog)

        const element = config.element.transferControlToOffscreen()
        const backend = new Webcodecs({ element, catalog })

        return new Player(connection, catalog, backend)
    }

    async #run() {
        const inits = new Set<string>()
        const tracks = new Array<Mp4Track>()

        // to get low res first use the following:
        // for (const track of (this.#catalog.tracks as unknown as Mp4Track[]).sort((a, b) => -1 * a.data_track.localeCompare(b.data_track))) {
        for (const track of this.#catalog.tracks) {
            if (!isMp4Track(track)) {
                throw new Error(`expected CMAF track`)
            }

            if (isAudioTrack(track) && this.#backend instanceof MSE) {
                // TODO temporary hack to disable audio in MSE
                continue
            }

            // just one video and audio may be active at a time
            if (!this.#currentTracks.has(track.kind)) {
                this.#currentTracks.set(track.kind, track)
                // TODO: put this back
                if (!tracks.some((t) => t.init_track === track.init_track)) {
                    console.log("playback | run | adding init track", track.init_track)
                    inits.add(track.init_track)
                }
                if (!tracks.some((t) => t.data_track === track.data_track)) {
                    console.log("playback | run | adding data track", track.data_track)
                    tracks.push(track)
                }

                // Initialize the track buffer
                if (this.#latencyTarget > 0 && !this.#trackBuffers.has(track.data_track)) {
                    this.#trackBuffers.set(track.data_track, new TrackBuffer())
                }
            }
        }

        // Call #runInit on each unique init track
        // TODO do this in parallel with #runTrack to remove a round trip
        Array.from(tracks).forEach((track) => {
            // the following is a hack to prevent multiple init tracks from being run
            // actually, we prevent this by only adding the init track once by checking above
            if (track.kind === "video" && this.#backend instanceof Webcodecs) {
                this.#backend.setVideoTrack(track as VideoTrack)
            }
            if (!this.#runningTrackThreads.has(Catalog.getUniqueTrackId(track) + "_init")) {
                this.#runningTrackThreads.set(Catalog.getUniqueTrackId(track) + "_init", this.#runInit(track))
            }
            this.#runningTrackThreads.set(Catalog.getUniqueTrackId(track) + "_data", this.#runTrack(track))
        })

        this.#runBuffer().catch((e) => console.error(e))
        // Wait for all tracks to finish
        await this.runners()
    }

    async runners() {
        while (this.#runningTrackThreads.size > 0) {
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
        console.log("playback | runners | done")
    }

    async #runBuffer() {
        while (this.#runningTrackThreads.size > 0) {
            if (this.#latencyTarget < 0) {
                await new Promise((resolve) => setTimeout(resolve, 100))
                continue
            }
            const currentTrack = this.getCurrentVideoTrack()
            if (!currentTrack) {
                console.error("runBuffer | No current track")
                await new Promise((resolve) => setTimeout(resolve, 100))
                continue
            }

            let buffer = this.#trackBuffers.get(currentTrack.data_track)
            if (!buffer) {
                console.warn("runBuffer | No buffer for track", currentTrack.data_track)
                buffer = new TrackBuffer()
                this.#trackBuffers.set(currentTrack.data_track, buffer)
            }

            const bufferLength = buffer?.getBufferLength()
            if ((bufferLength || 0) === 0 && this.#latencyTarget > 0) {
                // console.log("playback | runBuffer | Nothing in buffer", currentTrack.data_track)
                await new Promise((resolve) => setTimeout(resolve, 100))
                continue
            }

            if (this.#latencyTarget > 0) {
                let waitMS = Player.GROUP_DURATION
                if (this.#latencyTarget === 0) {
                    waitMS = 0
                } //else if (this.#currentLatency === undefined) {
                //    waitMS = Math.max(Player.GROUP_DURATION, this.#latencyTarget - (bufferLength - 1) * Player.GROUP_DURATION)
                // } 
                else if (this.#latencyTarget >= (this.#currentLatency || 0)) {
                    // latency target: 5000
                    // current latency: 4200
                    if (!this.#bufferInitialized) {
                        // console.log("playback | runBuffer | buffer not initialized")
                        waitMS = Math.max(Player.GROUP_DURATION, this.#latencyTarget - bufferLength * Player.GROUP_DURATION)
                        this.#bufferInitialized = true
                    } else if (bufferLength > 0) {
                        // console.log("playback | runBuffer | don't wait")
                        // starve buffer, don't let stalling happen
                        waitMS = Player.GROUP_DURATION
                    }
                } else if ((this.#currentLatency || 0) >= this.#latencyTarget + Player.GROUP_DURATION) {
                    // latency target: 5000
                    // current latency: 6000
                    // TODO: magic number is 0.7 which makes the speed-up rate to 1/0.7.
                    // console.log("playback | runBuffer | speedup")
                    waitMS = Player.GROUP_DURATION * 0.7
                }

                console.log("playback | runBuffer | bufferLength:%d currentLatency:%d waitMS:%d", bufferLength, this.#currentLatency, waitMS)

                if (waitMS > 0) {
                    await new Promise((resolve) => setTimeout(resolve, waitMS))
                }
            }

            const nextSegmentToPlay = buffer.nextSegment
            if (!nextSegmentToPlay) {
                if (this.#latencyTarget > 0) {
                    console.warn("runBuffer | no nextSegment")
                }
                await new Promise((resolve) => setTimeout(resolve, 100))
                continue
            }
            this.#backend.segment(nextSegmentToPlay)
            // console.log("playback | runBuffer | played from buffer", nextSegmentToPlay.header.ntp_timestamp)
        }
    }

    async #runInit(track: Mp4Track) {
        const name = track.init_track
        console.log("playback | runInit", name)
        const sub = await this.#connection.subscribe("", name)
        this.#currentSubscriptions.set(name, sub)

        const uniqueTrackId = Catalog.getUniqueTrackId(track)

        try {
            const init = await Promise.race([sub.data(), this.#running])
            if (!init) throw new Error("no init data")

            this.#backend.init({ stream: init.stream, name })
        } finally {
            if (this.#currentSubscriptions.has(track.init_track)) {
                this.#currentSubscriptions.delete(track.init_track)
                await sub.close()
            }
            // remove the init track from the running track threads
            if (this.#runningTrackThreads.has(uniqueTrackId + "_init")) {
                this.#runningTrackThreads.delete(uniqueTrackId + "_init")
            }

            if (this.#trackBuffers.has(track.data_track)) {
                const buffer = this.#trackBuffers.get(track.data_track)
                if (buffer) {
                    buffer.clear()
                }
            }
        }
    }

    async #runTrack(track: Mp4Track) {
        // console.log("playback | runTrack", track)
        if (track.kind !== "audio" && track.kind !== "video") {
            throw new Error(`unknown track kind: ${track.kind}`)
        }

        const uniqueTrackId = Catalog.getUniqueTrackId(track)

        if (!uniqueTrackId) {
            throw new Error("missing unique track id")
        }

        // When this is false, the transition is smoother
        // but when there's congestion, the video stalls because
        // two subscriptions are competing for bandwidth.
        const dontSubBeforePrevTrackIsDone = false
        let subInited = false
        let sub: SubscribeSend
        let failedSegmentRead = 0
        try {
            for (;;) {
                const doSubscribe = !subInited && (!dontSubBeforePrevTrackIsDone || this.isPlayingTrack(track))
                if (doSubscribe) {
                    console.log("playback | runTrack | subscribing", track.data_track)
                    subInited = true
                    let switchTrackId: bigint = BigInt(0)
                    if (this.#enableSwitchTrackIdFeature) {
                        const currentSub = this.#currentSubscriptions.get(this.getCurrentVideoTrack()?.data_track)
                        switchTrackId = (currentSub?.id || 0) as bigint
                    }
                    sub = await this.#connection.subscribe("", track.data_track, switchTrackId)
                    this.#currentSubscriptions.set(track.data_track, sub)
                }

                // wait for the previous video track to be done
                if (!subInited && !this.isPlayingTrack(track)) {
                    // delay 50ms
                    console.log("playback | runTrack | delaying 50ms", track.kind, track.data_track)
                    await new Promise((resolve) => setTimeout(resolve, 50))
                    continue
                }

                if (!this.getCurrentVideoTrack()) {
                    this.setCurrentVideoTrack(track as VideoTrack)
                }

                /* TODO: uncomment
				if (!this.#currentTracks.has(track.kind)) {
					console.log("playback | runTrack | track no longer active", track.kind)
					break
				}
				*/

                let segmentDone = false

                // wait for the next video track to be set
                // when it's set, the race will be won by the nextVideoTrackSet promise
                const nextVideoTrackSet = new Promise<void>((resolve) => {
                    const check = () => {
                        if (segmentDone) {
                            // segment is done, so we can resolve
                            resolve()
                            return
                        } else if (this.#nextVideoTrack) {
                            if (Catalog.getUniqueTrackId(this.#nextVideoTrack) !== uniqueTrackId) {
                                // console.log("playback | nextVideoTrackSet", this.#nextVideoTrack)
                                // let the current segment finish
                                // setTimeout(resolve, 1000)
                                resolve()
                                return
                            }
                        }
                        // segment is not done and next video track is not set, so check again
                        setTimeout(check, 10)
                    }

                    check()
                })

                const setNextVideoTrackIfExists = () => {
                    if (this.#nextVideoTrack) {
                        const nextTrackId = Catalog.getUniqueTrackId(this.#nextVideoTrack)
                        if (nextTrackId !== uniqueTrackId) {
                            if (this.#latencyTarget > 0) {
                                const minBufferLengthToSwitch = Math.ceil(this.#latencyTarget / Player.GROUP_DURATION)
                                const currentBufferItemCount = this.#trackBuffers?.get(this.#nextVideoTrack.data_track)?.getBufferLength() || 0
                                if (currentBufferItemCount < minBufferLengthToSwitch) {
                                    // console.log("playback | runTrack | not enough buffer to switch", this.#nextVideoTrack.data_track, uniqueTrackId, currentBufferItemCount, minBufferLengthToSwitch)
                                    return false
                                }
                            }

                            console.log("playback | runTrack | switching to next video track", uniqueTrackId, nextTrackId)
                            this.setCurrentVideoTrack(this.#nextVideoTrack)
                            return true
                        }
                    }
                    return false
                }

                console.log("playback | runTrack | fetch segment", track.kind, uniqueTrackId)
                const segment = await Promise.race([sub!.data(), this.#running, nextVideoTrackSet])
                if (!segment) {
                    segmentDone = false
                    failedSegmentRead++
                    if (failedSegmentRead > 10) {
                        console.error("playback | runTrack | failed to read segment", track.kind, uniqueTrackId)
                        break
                    }
                } else {
                    segmentDone = true
                    let buffer = this.#trackBuffers.get(track.data_track)
                    if (!buffer) {
                        this.#trackBuffers.set(track.data_track, new TrackBuffer())
                        buffer = this.#trackBuffers.get(track.data_track)
                    }

                    if (!buffer) throw new Error("missing buffer")

                    // add incoming to buffer
                    // before adding the segment to the buffer, pipe it through the throughput estimator
                    const callback = (value: number) => this.dispatchEvent(new CustomEvent("stat", { detail: { type: "measuredBandwidth", value } }))
                    const tpEstimator = new TPEstimator(this.#measuredBandwidth, callback)
                    // const segmentStream = segment.stream.pipeThrough(tpEstimator.stream)
                    const segmentId = segment.header.group + " " + segment.header.object + " " + segment.header.ntp_timestamp
                    tpEstimator.segmentId = segmentId

                    if (this.#latencyTarget > 0) {
                        // force stream to be fetched in order for the tpEstimator to work
                        setTimeout(async () => {
                            if (!this.#useProbing) {
                                segment.stream = arrayToReadableStream(await readStream(segment.stream.pipeThrough(tpEstimator.stream)))
                            }
                            buffer.addSegment({
                                init: track.init_track,
                                data: track.data_track,
                                kind: track.kind as "audio" | "video",
                                header: segment.header,
                                stream: segment.stream
                            })
                        }, 0)
                        console.log("playback | runTrack | segment buffered", track.data_track, uniqueTrackId, segment.header.ntp_timestamp)
                    } else {
                        if (!this.#useProbing) {
                            segment.stream = segment.stream.pipeThrough(tpEstimator.stream)
                        }
                        this.#backend.segment({
                            init: track.init_track,
                            data: track.data_track,
                            kind: track.kind,
                            header: segment.header,
                            stream: segment.stream
                        })
                        console.log("playback | runTrack | segment played out", track.data_track, uniqueTrackId, segment.header.ntp_timestamp)
                    }
                }
                if (setNextVideoTrackIfExists()) {
                    break
                }
            }
        } finally {
            console.log("playback | runTrack | closing subscription", track, uniqueTrackId)
            if (this.#currentSubscriptions.has(track.data_track)) {
                this.#currentSubscriptions.delete(track.data_track)
            }
            // remove the data track from the running track threads
            if (this.#runningTrackThreads.has(uniqueTrackId + "_data")) {
                this.#runningTrackThreads.delete(uniqueTrackId + "_data")
            }
            // clear the buffer
            this.#trackBuffers.set(track.data_track, new TrackBuffer())

            if (this.#currentTracks.get("video") === track) {
                this.#currentTracks.delete("video")
            }

            sub!.close()
        }
    }

    downloadProbeStats = () => {
        const link = document.createElement("a")
        document.body.appendChild(link)

        // download logs
        if (this.#probeTestResults.length > 0) {
            const headers = ["duration", "size", "bandwidth"]
            const csvContent = "data:application/vnd.ms-excel;charset=utf-8," + headers.join("\t") + "\n" + this.#probeTestResults.map((e) => Object.values(e).join("\t")).join("\n")
            const encodedUri = encodeURI(csvContent)
            link.setAttribute("href", encodedUri)
            link.setAttribute("download", "logs_" + Date.now() + ".xls")
            link.click()
        } else {
            console.warn("playback | downloadProbeStats | no logs")
        }

        link.remove()
    }

    runProbe = async () => {
        console.log("playback | runProbe")

        let totalIteration = 0
        if (this.#useProbeTestData && this.#probeTestData) {
            const totalProbeSizes = (this.#probeTestData.stop - this.#probeTestData.start) / this.#probeTestData.increment + 1
            totalIteration = totalProbeSizes * this.#probeTestData.iteration
            console.log("playback | probe | totalIteration", totalIteration)
            this.#probeSize = this.#probeTestData.start + Math.floor(this.#probeTestData.lastIteration / this.#probeTestData.iteration) * this.#probeTestData.increment
            ++this.#probeTestData.lastIteration
        }

        let sub: SubscribeSend
        try {
            const start = performance.now()
            // .probe:20000:0
            const probeTrackName = ".probe:" + this.#probeSize + ":" + this.#probePriority
            sub = await this.#connection.subscribe("", probeTrackName)
            // a delay
            console.log("playback | probe sub", sub, probeTrackName)
            const result = await Promise.race([sub.data(), this.#running])
            console.log("playback | probe subSend", result)
            if (result) {
                const reader = result.stream.getReader()
                let done = false
                let totalBufferSize = 0
                let rtt = 0
                while (!done) {
                    const { value, done: d } = await reader.read()
                    totalBufferSize += value?.byteLength ?? 0
                    done = d
                    if (rtt === 0) {
                        rtt = performance.now() - start
                    }
                    if (done) {
                        console.log("playback | probe | buffer: %d", totalBufferSize)
                        const end = performance.now()
                        const duration = end - start
                        const measuredBandwidth = (totalBufferSize * 8) / (duration / 1000) / 1000
                        const tc_bandwidth = parseFloat(localStorage.getItem("tc_bandwidth") || "0") || 0
                        console.log("playback | probe | duration: %d size: %d measured: %f tc_w: %f", duration, totalBufferSize, measuredBandwidth.toFixed(2), tc_bandwidth.toFixed(2))
                        this.dispatchEvent(new CustomEvent("stat", { detail: { type: "measuredBandwidth", value: measuredBandwidth } }))
                        this.#probeTestResults.push([duration, totalBufferSize, measuredBandwidth.toFixed(2), tc_bandwidth.toFixed(2)])
                    }
                }
            }
        } catch (e) {
            console.error("playback | probe error", e)
        } finally {
            console.log("playback | probe done")
            sub!.close()
        }

        if (this.#useProbeTestData && this.#probeTestData.lastIteration === totalIteration) {
            this.downloadProbeStats()
            this.#probeTestData.lastIteration = 0
            // stop the probe
            clearInterval(this.#probeTimer)
        }
    }

    #onMessage = (msg: Message.FromWorker) => {
        if (msg.timeline) {
            //this.#timeline.update(msg.timeline)
        } else if (msg.latency) {
            this.dispatchEvent(new CustomEvent("stat", { detail: { type: "latency", value: msg.latency } }))
        } else if (!this.#useProbing && msg.measuredBandwidth) {
            // If the bandwidth measurement is done in the worker, we can catch this message here
            // but if it's done in the main thread, the following line won't be reached
            // this.dispatchEvent(new CustomEvent("stat", { detail: { type: "measuredBandwidth", value: msg.measuredBandwidth } }))
        } else if (msg.stall) {
            this.dispatchEvent(new CustomEvent("stat", { detail: { type: "stall", value: msg.stall } }))
        } else if (msg.skip) {
            this.dispatchEvent(new CustomEvent("skip", { detail: msg.skip }))
        } else if (msg.trackId) {
            this.dispatchEvent(new CustomEvent("track_change", { detail: msg.trackId }))
        }
    }

    async close(err?: Error) {
        if (err) this.#abort(err)
        else this.#close()

        if (this.#connection) this.#connection.close()
        if (this.#backend) await this.#backend.close()
        if (this.#backend instanceof Webcodecs) this.#backend.off()
    }

    async closed(): Promise<Error | undefined> {
        try {
            await this.#running
        } catch (e) {
            return asError(e)
        }
    }

    /*
	play() {
		this.#backend.play({ minBuffer: 0.5 }) // TODO configurable
	}

	seek(timestamp: number) {
		this.#backend.seek({ timestamp })
	}
	*/

    async play() {
        // await this.#backend.play()
    }

    /*
	async *timeline() {
		for (;;) {
			const [timeline, next] = this.#timeline.value()
			if (timeline) yield timeline
			if (!next) break

			await next
		}
	}
	*/

    getCatalog() {
        return this.#catalog
    }

    // Only one audio and video track may be active at a time
    isPlayingTrack(track: Mp4Track) {
        return this.#currentTracks.get(track.kind) === track
    }

    selectVideoTrack(track: VideoTrack) {
        console.log("playback | selectVideoTrack", track)
        if (track.kind !== "video") {
            throw new Error(`expected video track`)
        }

        if (this.#nextVideoTrack) {
            console.warn("playback | selectVideoTrack | next video track already set", this.#nextVideoTrack)
            return
        }

        if (this.#currentTracks.get("video") === track) {
            console.warn("playback | selectVideoTrack | already playing video track", track)
            return
        }

        this.#nextVideoTrack = track
        this.#runningTrackThreads.set(Catalog.getUniqueTrackId(track) + "_data", this.#runTrack(track))
    }

    getCurrentVideoTrack() {
        return this.#currentTracks.get("video") as VideoTrack
    }

    setCurrentVideoTrack(track: Mp4Track) {
        const currentTrack = this.#currentTracks.get("video")

        if (currentTrack) {
            if (this.#currentSubscriptions.has(currentTrack.init_track)) {
                this.#currentSubscriptions.delete(currentTrack.init_track)
            }

            if (this.#currentSubscriptions.has(currentTrack.data_track)) {
                this.#currentSubscriptions.delete(currentTrack.data_track)
            }
        }

        this.#currentTracks.set("video", track)

        const backend = this.#backend
        backend.setVideoTrack(track as VideoTrack)
        this.#nextVideoTrack = undefined
    }

    setServerTimeOffset(serverTimeOffset: number) {
        this.#backend.setServerTimeOffset(serverTimeOffset)
    }

    resetBandwidthMeasurement() {
        const backend = this.#backend
        backend.resetSWMA()
    }

    setLatencyTarget(seconds: number) {
        if (seconds < 0) throw new Error("latency target must be greater than or equal to 0")
        const latencyTarget = Math.max(0, Math.ceil((seconds * 1000) / Player.GROUP_DURATION)) * 1000
        if (latencyTarget > this.#latencyTarget) {
            // build-up buffer again
            this.#bufferInitialized = false
        }
        this.#latencyTarget = latencyTarget
    }

    setCurrentLatency(milliseconds: number) {
        this.#currentLatency = milliseconds
    }
}
