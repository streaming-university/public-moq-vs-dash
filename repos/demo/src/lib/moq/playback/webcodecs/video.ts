import { SWMA } from "../../common/utils"
import { VideoTrack } from "../../media/catalog"
import * as MP4 from "../../media/mp4"
import * as Message from "./message"
import { Frame, Component } from "./timeline"

export class Renderer {
    #canvas: OffscreenCanvas
    #timeline: Component

    #decoder!: VideoDecoder
    #queue: TransformStream<Frame, VideoFrame>
    #prftMap = new Map<number, number>() // PTS -> NTP
    #currentVideoTrack?: VideoTrack
    #serverTimeOffset: number = 0

    #state = {
        lastDisplayTime: 0,
        tickHandlerStarted: false,
        differences: new SWMA(20, "stall-diff"),
        lastTrackId: "",
        lastFrameTimestamp: 0
    }

    constructor(config: Message.ConfigVideo, timeline: Component) {
        this.#canvas = config.canvas
        this.#timeline = timeline

        this.#queue = new TransformStream({
            start: this.#start.bind(this),
            transform: this.#transform.bind(this)
        })

        this.#run().catch(console.error)
    }

    async #run() {
        let frameWaiting = Promise.resolve()
        let previousFrame: VideoFrame | undefined

        const reader = this.#timeline.frames.pipeThrough(this.#queue).getReader()
        let lastFrameReceipt = -1
        for (;;) {
            await frameWaiting
            if (lastFrameReceipt > -1) {
                const diff = performance.now() - lastFrameReceipt
                // TODO: this is a hack to keep the frame rate at 30fps (ZG). Make this parameterized.
                const frameTime = 1000 / 30
                if (diff < frameTime) {
                    const wait = frameTime - diff
                    await new Promise((resolve) => setTimeout(resolve, wait))
                }
            }
            lastFrameReceipt = performance.now()
            const { value: frame, done } = await reader.read()
            if (done) break

            const prft = this.#prftMap.get(frame.timestamp)
            let ntp = ntptoms(prft)

            // See if the track has changed
            if (this.#currentVideoTrack && this.#currentVideoTrack.data_track !== this.#state.lastTrackId) {
                this.#state.lastTrackId = this.#currentVideoTrack.data_track
                postMessage({ trackId: this.#state.lastTrackId })
            }

            // Post the latency to the main thread
            if (!isNaN(this.#serverTimeOffset)) {
                ntp -= this.#serverTimeOffset
            }
            postMessage({
                latency: (performance.now() + performance.timeOrigin - ntp) / 1000
            })

            // Setup frame wait promise
            frameWaiting = new Promise((resolve) => {
                this.#displayFrame(frame, previousFrame)
                    .then(() => {
                        if (previousFrame) previousFrame.close()
                        previousFrame = frame
                    })
                    .then(resolve)
                    .catch(console.error)
            })

            if (!this.#state.tickHandlerStarted) {
                self.requestAnimationFrame(this.#tickHandler.bind(this))
                this.#state.tickHandlerStarted = true
            }
        }
    }

    async #displayFrame(frame: VideoFrame, previousFrame: VideoFrame | undefined): Promise<void> {
        const pts = frame.timestamp
        const previousPts = previousFrame?.timestamp || frame.timestamp
        let ptsDiff = (pts - previousPts) / 1000
        let lastRAF: number | undefined = undefined

        return new Promise((resolve) => {
            const fn = (now: number) => {
                if (ptsDiff > 0) {
                    if (!lastRAF) lastRAF = now
                    const localDiff = now - lastRAF
                    ptsDiff -= localDiff
                    if (ptsDiff > 0) {
                        return self.requestAnimationFrame(fn)
                    }
                }

                this.#canvas.width = frame.displayWidth
                this.#canvas.height = frame.displayHeight

                const ctx = this.#canvas.getContext("2d")
                if (!ctx) throw new Error("failed to get canvas context")

                // Difference calculation for stall
                const diff = now - this.#state.lastDisplayTime
                this.#state.differences.next(diff)
                this.#state.lastDisplayTime = now

                ctx.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight) // TODO respect aspect ratio

                // assuming that resolutions don't exceed this...
                const scale = frame.displayWidth / 1920
                ctx.fillStyle = "rgba(0, 0, 0, 0.5)"
                ctx.fillRect(20 * scale, 20 * scale, 950 * scale, 70 * scale)
                ctx.font = 60 * scale + "px courier"
                ctx.fillStyle = "white"
                ctx.fillText(`w:${frame.displayWidth} h:${frame.displayHeight} b: ${((this.#currentVideoTrack?.bit_rate || 0) / 1000).toFixed(0)} Kbps`, 50 * scale, 70 * scale)
                // ctx.fillText(`pts:${(frame.timestamp / 15360).toFixed(2)}`, 50 * scale, 120 * scale) // tn = 15360
                resolve()
            }

            self.requestAnimationFrame(fn)
        })
    }

    #tickHandler(now: number) {
        const diff = now - this.#state.lastDisplayTime
        const swma = this.#state.differences.next()
        // TODO: This is needed because I don't want to mess with syncronisation. But it's not ideal.
        if (diff > swma * 2) {
            postMessage({ stall: { since: this.#state.lastDisplayTime, duration: diff } })
        }
        self.requestAnimationFrame(this.#tickHandler.bind(this))
    }

    #start(controller: TransformStreamDefaultController<VideoFrame>) {
        this.#decoder = new VideoDecoder({
            output: (frame: VideoFrame) => {
                controller.enqueue(frame)
            },
            error: console.error
        })
    }

    #transform(frame: Frame) {
        // Configure the decoder with the first frame
        //if (this.#decoder.state !== "configured") {

        // TODO: when resolution changes, reset decoder ZG
        const { sample, track } = frame

        if (!MP4.isVideoTrack(track)) throw new Error("expected video track")

        // console.log("renderer | transform | frame", frame.track.id)
        if (this.#canvas.width !== frame.track.track_width) {
            const desc = sample.description
            const box = desc.avcC ?? desc.hvcC ?? desc.vpcC ?? desc.av1C
            if (!box) throw new Error(`unsupported codec: ${track.codec}`)

            const buffer = new MP4.Stream(undefined, 0, MP4.Stream.BIG_ENDIAN)
            box.write(buffer)
            const description = new Uint8Array(buffer.buffer, 8) // Remove the box header.

            // if the frame is not a keyframe, wait for it
            if (frame.sample.is_sync) {
                this.#decoder.configure({
                    codec: track.codec,
                    codedHeight: track.video.height,
                    codedWidth: track.video.width,
                    description
                    // optimizeForLatency: true
                })
            }
        }

        const chunk = new EncodedVideoChunk({
            type: frame.sample.is_sync ? "key" : "delta",
            data: frame.sample.data,
            timestamp: frame.sample.cts //frame.sample.dts / frame.track.timescale,
        })

        for (const prft of frame.prfts) {
            this.#prftMap.set(chunk.timestamp, prft.ntp_timestamp)
        }

        this.#decoder.decode(chunk)
    }

    setVideoTrack(videoTrack: VideoTrack) {
        // console.log("renderer | setVideoTrack", videoTrack)
        this.#currentVideoTrack = videoTrack
    }

    setServerTimeOffset(serverTimeOffset: number) {
        // console.log("renderer | setVideoTrack", videoTrack)
        this.#serverTimeOffset = serverTimeOffset
    }
}

function ntptoms(ntpTimestamp?: number) {
    if (!ntpTimestamp) return NaN

    const ntpEpochOffset = 2208988800000 // milliseconds between 1970 and 1900

    // Split the 64-bit NTP timestamp into upper and lower 32-bit parts
    const upperPart = Math.floor(ntpTimestamp / Math.pow(2, 32))
    const lowerPart = ntpTimestamp % Math.pow(2, 32)

    // Calculate milliseconds for upper and lower parts
    const upperMilliseconds = upperPart * 1000
    const lowerMilliseconds = (lowerPart / Math.pow(2, 32)) * 1000

    // Combine both parts and adjust for the NTP epoch offset
    return upperMilliseconds + lowerMilliseconds - ntpEpochOffset
}
