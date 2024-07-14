type HistoryItem = {
    time: number
    value: number
}

type Snapshot = {
    current: number
    ratio: number
}

export type AggregatorType = "moq" | "dash"
export type PlayerType = AggregatorType

export type AggregatorSnapshot = {
    [key in keyof AggregatorData]: Snapshot
}

export interface AggregatorData {
    latency: {
        history: HistoryItem[]
        invert: boolean
    }
    measuredBandwidth: {
        history: HistoryItem[]
        invert: boolean
    }
    stallDuration: {
        history: HistoryItem[]
        invert: boolean
    }
    bitrate: {
        history: HistoryItem[]
        invert: boolean
    }
    skippedDuration: {
        history: HistoryItem[]
        invert: boolean
    }
}

export interface SynchroniserSnapshot {
    snapshot: AggregatorSnapshot
    data: AggregatorData
}

export interface SynchroniserData {
    moq: AggregatorData
    dash: AggregatorData
}

export interface SynchroniserEventData {
    identifier: AggregatorType
    data: AggregatorData
}

export interface Track {
    id: string | undefined,
    sid: string | undefined
    bitrate: number | undefined
    size: {
        width: number
        height: number
    }
}
