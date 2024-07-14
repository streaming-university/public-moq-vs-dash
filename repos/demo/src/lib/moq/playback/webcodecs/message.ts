import { Header } from "../../transport/object"
import { RingShared } from "../../common/ring"
import { VideoTrack } from "../../media/catalog"

export interface Config {
    audio?: ConfigAudio
    video?: ConfigVideo
}

export interface ConfigAudio {
    channels: number
    sampleRate: number

    ring: RingShared
}

export interface ConfigVideo {
    canvas: OffscreenCanvas
}

export interface Init {
    name: string // name of the init object
    stream: ReadableStream<Uint8Array>
}

export interface Segment {
    init: string // name of the init object
    data: string // name of the data object
    kind: "audio" | "video"
    header: Header
    stream: ReadableStream<Uint8Array>
}

/*
export interface Play {
	// Start playback once the minimum buffer size has been reached.
	minBuffer: number
}

export interface Seek {
	timestamp: number
}
*/

// Sent periodically with the current timeline info.
export interface Timeline {
    // The current playback position
    timestamp?: number

    // Audio specific information
    audio: TimelineAudio

    // Video specific information
    video: TimelineVideo
}

export interface TimelineAudio {
    buffer: Range[]
}

export interface TimelineVideo {
    buffer: Range[]
}

export interface Range {
    start: number
    end: number
}

// Used to validate that only the correct messages can be sent.

// Any top level messages that can be sent to the worker.
export interface ToWorker {
    // Sent to configure on startup.
    config?: Config

    // Sent on each init/data stream
    init?: Init
    segment?: Segment

    /*
	// Sent to control playback
	play?: Play
	seek?: Seek
	*/
    // Sent to change the current video track
    currentVideoTrack?: VideoTrack
    resetSWMA?: boolean
    serverTimeOffset?: number // in ms
}

// Any top-level messages that can be sent from the worker.
export interface FromWorker {
    // Sent back to the main thread regularly to update the UI
    timeline?: Timeline
    skip?: SkipEvent
    latency?: number
    measuredBandwidth?: number
    trackId?: string
    stall?: {
        since: number
        duration: number
    }
}

export interface SkipEvent {
    type: "too_slow" | "too_old"
    skippedGroup: { sequence: number; track: string }
    currentGroup: { sequence: number; track: string }
    duration: number
}

/*
interface ToWorklet {
	config?: Audio.Config
}

*/
