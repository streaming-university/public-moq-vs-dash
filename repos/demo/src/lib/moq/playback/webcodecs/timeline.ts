import type { Frame } from "../../media/mp4"
export type { Frame }

export interface Range {
    start: number
    end: number
}

export class Timeline {
    // Maintain audio and video seprarately
    audio: Component
    video: Component

    // Construct a timeline
    constructor() {
        this.audio = new Component()
        this.video = new Component()
    }
}

interface Segment {
    track: string
    sequence: number
    frames: ReadableStream<Frame>
}

export class Component {
    #current?: Segment

    frames: ReadableStream<Frame>
    #segments: TransformStream<Segment, Segment>
    #sequenceDurationMap = new Map<string, number>()

    #framesCompleted = false

    constructor() {
        this.frames = new ReadableStream({
            pull: this.#pull.bind(this),
            cancel: this.#cancel.bind(this)
        })

        // This is a hack to have an async channel with 100 items.
        this.#segments = new TransformStream({}, { highWaterMark: 100 })
    }

    get segments() {
        return this.#segments.writable
    }

    async #pull(controller: ReadableStreamDefaultController<Frame>) {
        for (;;) {
            // Get the next segment to render.
            let segments
            let res: ReadableStreamReadResult<Segment> | ReadableStreamReadResult<Frame>

            try {
                segments = this.#segments.readable.getReader()

                if (this.#current) {
                    let frames
                    try {
                        // Get the next frame to render.
                        frames = this.#current.frames.getReader()

                        // Wait for either the frames or segments to be ready.
                        // NOTE: This assume that the first promise gets priority.
                        res = await Promise.race([frames.read(), segments.read()])
                    } catch (e) {
                        // TODO handle errors
                        console.error("error in timeline pull 1", e)
                        continue
                    } finally {
                        if (frames) frames.releaseLock()
                    }
                } else {
                    res = await segments.read()
                }
            } catch (e) {
                console.error("error in timeline pull 2", e)
                continue
            } finally {
                if (segments) segments.releaseLock()
            }

            const { value, done } = res

            if (done) {
                // We assume the current segment has been closed
                // TODO support the segments stream closing
                // console.log("timeline stream done", value)
                this.#current = undefined
                continue
            }

            if (!isSegment(value)) {
                if (!this.#current) throw new Error("impossible. a frame without segment")

                // We got a frame, so we need to update the sequence duration
                const id = this.#current.track + this.#current.sequence
                const duration = this.#sequenceDurationMap.get(id)!

                // Update the sequence duration
                // console.log("updating sequence duration", id, duration + value.sample.duration / value.sample.timescale)
                this.#sequenceDurationMap.set(id, duration + value.sample.duration / value.sample.timescale)

                // Return so the reader can decide when to get the next frame.
                controller.enqueue(value)

                // assuming the GOP duration is 1 second
                // in order to avoid excession skip messages, we check if all frames are received
                // and if so, we set the framesCompleted flag to true
                if (Math.floor(duration + value.sample.duration / value.sample.timescale + 0.0001) === 1) {
                    this.#framesCompleted = true
                }
                return
            }

            // We didn't get any frames, and instead got a new segment.
            if (this.#current && !this.#framesCompleted) {
                let skipDuration = 0
                const maxDuration = [...this.#sequenceDurationMap.values()].reduce((acc, duration) => Math.max(acc, duration), 0)
                if (this.#sequenceDurationMap.has(this.#current.track + this.#current.sequence)) {
                    const duration = this.#sequenceDurationMap.get(this.#current.track + this.#current.sequence)!
                    skipDuration = maxDuration - duration
                }

                if (value.sequence < this.#current.sequence) {
                    // The incoming segment is older than the current, abandon the incoming one.
                    try {
                        await value.frames.cancel(
                            "skipping incoming segment; too old | sequence (incoming): " + value.sequence + " | current sequence: " + this.#current.sequence + " track: " + this.#current.track
                        )
                    } finally {
                        postMessage({
                            skip: {
                                type: "too_old",
                                skippedGroup: { sequence: value.sequence, track: value.track },
                                currentGroup: { sequence: this.#current.sequence, track: this.#current.track },
                                duration: skipDuration
                            }
                        })
                    }
                    continue
                } else {
                    // The incoming segment is newer than the current, cancel the current one.
                    try {
                        // Our segment is newer than the current, cancel the old one.
                        await this.#current.frames.cancel(
                            "skipping current segment; too slow | sequence (incoming): " + value.sequence + " | current sequence: " + this.#current.sequence + " track: " + this.#current.track
                        )
                    } finally {
                        postMessage({
                            skip: {
                                type: "too_slow",
                                skippedGroup: { sequence: this.#current.sequence, track: this.#current.track },
                                currentGroup: { sequence: value.sequence, track: value.track },
                                duration: skipDuration
                            }
                        })
                    }
                }
            }
            this.#framesCompleted = false
            this.#current = value
            this.#sequenceDurationMap.set(this.#current.track + this.#current.sequence, 0)
        }
    }

    async #cancel(reason: any) {
        if (this.#current) {
            await this.#current.frames.cancel(reason)
        }

        const segments = this.#segments.readable.getReader()
        for (;;) {
            const { value: segment, done } = await segments.read()
            if (done) break

            await segment.frames.cancel(reason)
        }
    }
}

// Return if a type is a segment or frame
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
function isSegment(value: Segment | Frame): value is Segment {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return (value as Segment).frames !== undefined
}
