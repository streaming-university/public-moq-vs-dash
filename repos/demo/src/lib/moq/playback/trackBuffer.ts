import { TPEstimator } from "../common/utils"
import * as Message from "./webcodecs/message"

export class TrackBuffer {
    #playbackBuffer: Message.Segment[] = []
    #groupByTimestamp: Map<number, number> = new Map() // by 10ms precision

    constructor() {
        this.#playbackBuffer = []
    }

    get nextSegment(): Message.Segment | undefined {
        const next = this.#playbackBuffer.shift()
        return next
    }

    get isBufferEmpty(): boolean {
        return this.#playbackBuffer.length === 0
    }

    addSegment(segment: Message.Segment) {
        // TODO: This is a hack. We remove the same timestamped segments out of
        // the buffer. This needs to be fixed on the server-side, I think (ZG)
        if (segment.header.ntp_timestamp === undefined) {
            return
        }
        let maxGroupByTimestamp = 0
        if (this.#groupByTimestamp.has(Math.floor(segment.header.ntp_timestamp / 10))) {
            maxGroupByTimestamp = this.#groupByTimestamp.get(Math.floor(segment.header.ntp_timestamp / 10))!
        }
        if (segment.header.group! < maxGroupByTimestamp) {
            console.log("Lower group number, possible burst, discard", segment.header.group, maxGroupByTimestamp)
            return
        }

        this.#groupByTimestamp.set(Math.floor(segment.header.ntp_timestamp / 10), segment.header.group! || 0)

        if (maxGroupByTimestamp > 0) {
            // remove the old segment with the same timestamp (with 10ms precision)
            console.log("trackBuffer | remove old segment with the same timestamp", maxGroupByTimestamp)
            this.#playbackBuffer = this.#playbackBuffer.filter((s) => s.header.group! !== maxGroupByTimestamp)
        }
        this.#playbackBuffer.push(segment)
        this.#playbackBuffer = this.#playbackBuffer.sort((a, b) => a.header.group! - b.header.group!)
    }

    clear() {
        this.#playbackBuffer = []
    }

    getBufferLength(): number {
        return this.#playbackBuffer.length
    }
}
