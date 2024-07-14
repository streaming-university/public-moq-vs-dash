import { RingShared } from "../../common/ring"
import { AudioTrack, Catalog, Mp4Track, VideoTrack, isAudioTrack } from "../../media/catalog"
import { Segment, Init } from "../backend"
import { Context } from "./context"
import * as Message from "./message"

export interface PlayerConfig {
    element: OffscreenCanvas
    catalog: Catalog
}

// Responsible for sending messages to the worker and worklet.
export default class WebcodecsPlayerBackend {
    // General worker
    #worker: Worker

    // The audio context, which must be created on the main thread.
    #context?: Context

    #registeredListeners: Array<(e: MessageEvent) => void> = []

    constructor(config: PlayerConfig) {
        // TODO does this block the main thread? If so, make this async
        // this.#worker = new MediaWorker({ format: "es" })
        this.#worker = new Worker(new URL("./worker.ts", import.meta.url), {
            type: "module"
        })

        let sampleRate: number | undefined
        let channels: number | undefined

        for (const track of config.catalog.tracks) {
            if (isAudioTrack(track)) {
                if (sampleRate && track.sample_rate !== sampleRate) {
                    throw new Error(`TODO multiple audio tracks with different sample rates`)
                }

                sampleRate = track.sample_rate
                channels = Math.max(track.channel_count, channels ?? 0)
            }
        }

        const msg: Message.Config = {}

        // Only configure audio is we have an audio track
        if (sampleRate && channels) {
            msg.audio = {
                channels: channels,
                sampleRate: sampleRate,
                ring: new RingShared(2, sampleRate / 20) // 50ms
            }

            this.#context = new Context(msg.audio)
        }

        // TODO only send the canvas if we have a video track
        msg.video = {
            canvas: config.element
        }

        this.send({ config: msg }, msg.video.canvas)
    }

    // TODO initialize context now since the user clicked
    play() {}

    init(init: Init) {
        this.send({ init }, init.stream)
    }

    segment(segment: Segment) {
        // console.log("webcodecs | segment", segment)
        this.send({ segment }, segment.stream)
    }

    async close() {
        this.#worker.terminate()
        await this.#context?.close()
    }

    setVideoTrack(videoTrack: VideoTrack) {
        console.log("webcodecs | setVideoTrack", videoTrack)
        this.send({ currentVideoTrack: videoTrack })
    }

    setTargetLatency(targetLatency: number) {
        this.send({ targetLatency })
    }

    setServerTimeOffset(serverTimeOffset: number) {
        this.send({ serverTimeOffset })
    }

    resetSWMA() {
        this.send({ resetSWMA: true })
    }

    // Enforce we're sending valid types to the worker
    private send(msg: Message.ToWorker, ...transfer: Transferable[]) {
        //console.log("sent message from main to worker", msg)
        this.#worker.postMessage(msg, transfer)
    }

    on(callback: (msg: Message.FromWorker) => void) {
        const listener = (e: MessageEvent) => callback(e.data)
        this.#registeredListeners.push(listener)
        this.#worker.addEventListener("message", listener)
    }

    off() {
        for (;;) {
            const listener = this.#registeredListeners.pop()
            if (!listener) break
            this.#worker.removeEventListener("message", listener)
        }
    }
}
