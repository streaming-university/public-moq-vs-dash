import { Connection } from "../../transport"
import { Reader } from "../../transport/stream"
import { asError } from "../../common/error"

// JSON encoded catalog
export class Catalog {
    tracks = new Array<Track>()

    public getTracks(): Track[] {
        return this.tracks
    }

    public getVideoTracks(): VideoTrack[] {
        // console.log("getVideoTracks", this.tracks)
        return this.tracks.filter(isVideoTrack)
    }

    getAudioTracks(): AudioTrack[] {
        return this.tracks.filter(isAudioTrack)
    }

    encode(): Uint8Array {
        const encoder = new TextEncoder()
        const str = JSON.stringify(this)
        return encoder.encode(str)
    }

    static decode(raw: Uint8Array): Catalog {
        const decoder = new TextDecoder()
        const str = decoder.decode(raw)

        try {
            const catalog = new Catalog()
            catalog.tracks = JSON.parse(str).tracks

            if (!isCatalog(catalog)) {
                throw new Error("invalid catalog")
            }

            return catalog
        } catch (e) {
            throw new Error("invalid catalog")
        }
    }

    static async fetch(connection: Connection): Promise<Catalog> {
        let raw: Uint8Array

        const subscribe = await connection.subscribe("", ".catalog")
        console.debug("catalog fetch subscribe", subscribe)
        try {
            const segment = await subscribe.data()
            if (!segment) throw new Error("no catalog data")

            console.log("catalog fetch segment", segment)

            const { header, stream } = segment

            if (header.group !== 0) {
                throw new Error("TODO updates not supported")
            }

            if (header.object !== 0) {
                throw new Error("TODO delta updates not supported")
            }

            const reader = new Reader(stream)
            raw = await reader.readAll()
            console.log("catalog fetch raw", raw)

            await subscribe.close() // we done
        } catch (e) {
            console.debug("catalog fetch error", e)
            const err = asError(e)

            // Close the subscription after we're done.
            await subscribe.close(1n, err.message)

            throw err
        }

        return Catalog.decode(raw)
    }

    static getUniqueTrackId(mp4Track: Mp4Track) {
        if (mp4Track.kind === "audio") {
            const track = mp4Track as AudioTrack
            return `${track.kind}:${track.codec}:${track.channel_count}:${track.sample_rate}:${track.sample_size}`
        } else if (mp4Track.kind === "video") {
            const track = mp4Track as VideoTrack
            return `${track.kind}:${track.codec}:${track.width}:${track.height}:${track.frame_rate}`
        }
    }
}

export function isCatalog(catalog: any): catalog is Catalog {
    if (!Array.isArray(catalog.tracks)) return false
    return catalog.tracks.every((track: any) => isTrack(track))
}

export interface Track {
    kind: string
    container: string
}

export interface Mp4Track extends Track {
    container: "mp4"
    init_track: string
    data_track: string
}

export interface AudioTrack extends Mp4Track {
    kind: "audio"
    codec: string
    channel_count: number
    sample_rate: number
    sample_size: number
    bit_rate?: number
}

export interface VideoTrack extends Mp4Track {
    kind: "video"
    codec: string
    width: number
    height: number
    frame_rate: number
    bit_rate?: number
}

export function isTrack(track: any): track is Track {
    if (typeof track.kind !== "string") return false
    if (typeof track.container !== "string") return false
    return true
}

export function isMp4Track(track: any): track is Mp4Track {
    if (track.container !== "mp4") return false
    if (typeof track.init_track !== "string") return false
    if (typeof track.data_track !== "string") return false
    if (!isTrack(track)) return false
    return true
}

export function isVideoTrack(track: any): track is VideoTrack {
    if (track.kind !== "video") return false
    if (typeof track.codec !== "string") return false
    if (typeof track.width !== "number") return false
    if (typeof track.height !== "number") return false
    // frame rate is not required
    // if (typeof track.frame_rate !== "number") return false
    if (!isTrack(track)) return false
    return true
}

export function isAudioTrack(track: any): track is AudioTrack {
    if (track.kind !== "audio") return false
    if (typeof track.codec !== "string") return false
    if (typeof track.channel_count !== "number") return false
    if (typeof track.sample_rate !== "number") return false
    if (typeof track.sample_size !== "number") return false
    if (!isTrack(track)) return false
    return true
}
