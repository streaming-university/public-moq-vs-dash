interface ObjectCompleteness {
    done: boolean
    diff?: number
    parsedObjectCount?: number
}
export class SWMA {
    /*
    Sliding Window Moving Average
    Given size N, calculate the average of the last N values.
    Also filter out outliers by z-score.
    */

    #size: number
    #values: number[]
    #method: "std" | "p90" = "std"
    #lastCalculation: number = 0
    #label: string = "SWMA"

    constructor(size: number, label: string = "SWMA") {
        this.#size = size
        this.#values = []
        this.#label = label
    }

    reset() {
        this.#values = []
    }

    next(value?: number) {
        let val = this.#lastCalculation
        if (value && !isNaN(value)) {
            this.#values.push(value)
            if (this.#values.length > this.#size) {
                // remove as many values as the calculation window
                this.#values.shift()
            }
            val = this.#calc() ?? 0
            this.#lastCalculation = val
        }
        return val
    }

    #calc() {
        // If we don't have enough values, return only the last value
        /*if (this.#values.length < this.#size) {
            console.warn(`SWMA ${this.#label} | Not enough values for SWMA, returning last value: ${this.#values[this.#values.length - 1]}`)
            return this.#values[this.#values.length - 1]
        }*/

        if (this.#method === "p90") {
            // Sort the values
            const sorted = this.#values.sort((a, b) => a - b)

            // Get the 90th percentile
            const p95 = sorted[Math.floor(sorted.length * 0.95)]
            const p5 = sorted[Math.floor(sorted.length * 0.05)]

            // Filter out values that are more than 2 standard deviations from the mean
            const filtered = this.#values.filter((x) => x > p5 && x < p95)

            // Calculate the average of the filtered values
            const avg = filtered.reduce((a, b) => a + b, 0) / filtered.length
            console.log(`SWMA: ${this.#values.length} values, ${filtered.length} filtered, ${p5} p5, ${p95} p95 => ${avg}`, this.#values)
            return avg
        } else if (this.#method === "std") {
            // Calculate the average
            const mean = this.#values.reduce((a, b) => a + b, 0) / this.#values.length

            // Calculate the sample standard deviation
            const std = Math.sqrt(this.#values.map((x) => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / (this.#values.length - 1))

            // Filter out values that are more than 2 standard deviations from the mean
            const filtered = this.#values.filter((x) => Math.abs(x - mean) < 2 * std && x > 0)

            // Calculate the average of the filtered values
            const avg = filtered.reduce((a, b) => a + b, 0) / filtered.length
            // console.log(`SWMA: ${this.#values.length} values, ${filtered.length} filtered, ${mean} mean, ${std} std => ${avg}`, this.#values)
            return avg
        }
    }
}

enum ObjectReceiveStatus {
    None,
    Waiting,
    Done
}
export class TPEstimator {
    #measuredBandwidths: SWMA
    #passthrough: TransformStream<Uint8Array, Uint8Array>
    #lastTPutAnnounce: number = 0
    #announceInterval: number = 1000 // ms

    #lastObjectStart = 0
    #lastReceivedOffset = 0
    #previousChunkBuffer: Uint8Array = new Uint8Array()

    #currentObjectStatus: ObjectReceiveStatus = ObjectReceiveStatus.None

    #chunkCounter = 0

    #segmentId: string

    #resultCallback: (measurement: number) => void

    constructor(measuredBandwidths: SWMA, resultCallback: (measurement: number) => void) {
        this.#resultCallback = resultCallback
        this.#measuredBandwidths = measuredBandwidths

        this.#passthrough = new TransformStream<Uint8Array, Uint8Array>({
            transform: this.#transform.bind(this),
            flush: () => {}
        })
    }

    get stream() {
        return this.#passthrough
    }

    set segmentId (id: string) {
        this.#segmentId = id
    }

    get segmentId () {
        return this.#segmentId
    }

    isObjectComplete = (data: Uint8Array, parsedObjectCount = 0): ObjectCompleteness => {
        if (parsedObjectCount > 100) {
            throw new Error("TPEstimator | isObjectComplete | parsedObjectCount is too high. Something is wrong.")
        }

        if (data.length < 8) {
            return { done: false }
        }

        const prftLength = new DataView(data.buffer, 0, 4).getUint32(0)

        // do we have moof?
        if (prftLength && prftLength + 4 > data.length) {
            return { done: false }
        }

        const moofLength = new DataView(data.buffer, prftLength, 4).getUint32(0)

        // do we have mdat
        if (moofLength && prftLength + moofLength + 4 > data.length) {
            return { done: false }
        }

        const mdatLength = new DataView(data.buffer, prftLength + moofLength, 4).getUint32(0)

        const diff = data.length - (prftLength + moofLength + mdatLength)

        if (diff >= 0) {
            parsedObjectCount++
        }

        if (diff < 0 && parsedObjectCount === 0) {
            // we don't have enough data to parse the first object
            return { done: false }
        } else if (diff < 0 && parsedObjectCount > 0) {
            // there are more than one objects in the buffer but
            // the last one is incomplete
            // console.log("TPEstimator | isObjectComplete 1 | parsedObjectCount: %d, diff: %d", parsedObjectCount, diff)
            return { done: true, diff: diff, parsedObjectCount }
        } else if (diff > 0) {
            // we have more than one objects in the buffer
            // continue parsing the next object
            // console.log("TPEstimator | isObjectComplete 2 | parsedObjectCount: %d, data.length: %d diff: %d p/m/md:%d/%d/%d", parsedObjectCount, data.length, diff, prftLength, moofLength, mdatLength)
            return this.isObjectComplete(data.slice(data.length - diff), parsedObjectCount)
        } else {
            // objects are perfectly aligned in the buffer
            // we have one or more objects
            // console.log("TPEstimator | isObjectComplete 3 | parsedObjectCount: %d", parsedObjectCount, data.length, diff, prftLength, moofLength, mdatLength)
            return { done: true, diff: 0, parsedObjectCount }
        }
    }

    #transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
        const buffer = this.#previousChunkBuffer.length > 0 ? new Uint8Array([...this.#previousChunkBuffer, ...chunk]) : new Uint8Array(chunk)

        // GoP = CMAF segment = QUIC stream = MoQ Group
        // Object = CMAF chunk = QUIC stream frame = [prft][moof][mdat]

        // console.debug("TPEstimator | transform | chunk length: %d, previous chunk length: %d", chunk.length, this.#previousChunkBuffer.length)
        // const size = new DataView(copy.buffer, copy.byteOffset, copy.byteLength).getUint32(0)
        // const atom = await stream.bytes(size)

        // boxes: [prft][moof][mdat]...<idle time>...[prft][moof][mdat]
        // first 4 bytes => size
        // following 4 bytes => box type
        /*
        ---------------------------------
    t0  [prft][md                        at][moof][prft]
        ---------------------------------
        isObjectComplete: false
        waiting=true

        ---------------------------------
    t1                                   [prft][md  at][moof][prft]
        ---------------------------------
        
        isObjectComplete: true
        bw = size([md) / (t1-t0)

        ---------------------------------
    t2  [mdat][moof]                     [prft]
        ---------------------------------
        isObjectComplete: false

        o  o  o  o  o  o  o  o (B bps)
        o   o   o     o  o ooo 
        o   o   o     o     o     o

        C > B -> Source limited
        C < B -> Network limited
        R: congestion control rate
        R <= C
        */

        // if boxes come in one shot, we can measure the bandwidth by using the latency
        let latency = 0

        if (this.#currentObjectStatus === ObjectReceiveStatus.None) {
            if (buffer.length >= 32) {
                // get ntp_timestamp from the prft box
                const track_id = new DataView(buffer.buffer, 12, 4).getUint32(0)
                const ntp_timestamp = new Number(new DataView(buffer.buffer, 16, 8).getBigUint64(0))
                const recv_ts = ntptoms(ntp_timestamp.valueOf())
                latency = performance.now() + performance.timeOrigin - recv_ts
            }
        }
        // do we have all the boxes?
        let result: ObjectCompleteness = { done: false }

        try {
            result = this.isObjectComplete(buffer)
        } catch (e: any) {
            console.warn("TPEstimator | isObjectComplete | error: %s", e.message)
        }

        if (!result.done) {
            // we don't have all of the boxes. So we wait for the next chunk
            // we assume that the next chunk is on the link layer
            // so when we have it, we can measure the bandwidth
            this.#previousChunkBuffer = buffer
            if (this.#currentObjectStatus === ObjectReceiveStatus.None) {
                this.#currentObjectStatus = ObjectReceiveStatus.Waiting
                this.#lastObjectStart = performance.now() + performance.timeOrigin // recv_ts
                this.#lastReceivedOffset = buffer.length
            }
        } else {
            // if object status is none (not waiting), it means that
            // we had all the boxes in one chunk
            this.#chunkCounter++
            const isOneShot = this.#currentObjectStatus === ObjectReceiveStatus.None
            this.#currentObjectStatus = ObjectReceiveStatus.Done

            let downloadDuration = 0
            let tput = 0

            if (this.#lastObjectStart > 0) {
                downloadDuration = (performance.now() + performance.timeOrigin - this.#lastObjectStart) / 1000
                this.#lastObjectStart = 0
            }

            if (downloadDuration > 0.001 && this.#chunkCounter === 1) {
                tput = ((buffer.length - (result.diff ?? 0) - this.#lastReceivedOffset) * 8) / 1000 / downloadDuration
                // tput = ((buffer.length - this.#lastReceivedOffset) * 8) / 1000 / downloadDuration

                const measurement = this.#measuredBandwidths.next(tput)

                if (performance.now() - this.#lastTPutAnnounce > this.#announceInterval) {
                    console.log("TPEstimator | announcing bw measurement: %d segmentId: %s", measurement, this.#segmentId)
                    if (this.#segmentId) {
                        this.#lastTPutAnnounce = performance.now()
                        if (this.#resultCallback !== undefined) {
                            this.#resultCallback(measurement)
                        }
                    }
                }
                // console.log(`TPEstimator | dur: ${downloadDuration} buflen:${buffer.length} lROffset:${this.#lastReceivedOffset} diff:${result.diff} prevChunkLen: ${this.#previousChunkBuffer.length} meas:${measurement} tput:${tput} lOStart: ${this.#lastObjectStart} oneShot:${isOneShot} chunk: ${this.#chunkCounter}`)
            } else {
                // console.log(`TPEstimator | dur: ${downloadDuration} buflen:${buffer.length} lROffset:${this.#lastReceivedOffset} diff:${result.diff} prevChunkLen: ${this.#previousChunkBuffer.length} meas:0 tput:0 lOStart: ${this.#lastObjectStart} oneShot:${isOneShot} chunk: ${this.#chunkCounter}`)
            }

            /* 
            // TODO: this is not working. ZG. For one shot, I tried to measure the bandwidth by using the latency
            // but it did not work. So, I commented out this part. We discard one shot bandwidth measurement for now.
            if (tput === 0 && isOneShot && latency > 0) {
                const measurement = (buffer.length * 8) / 1000.0 / latency
                console.log("TPEstimator | one shot | latency: %d, bw measurement: %f", latency, measurement, buffer.length * 8)
            }
            */

            // pass overflowing data
            if (result.diff || 0 < 0) {
                this.#previousChunkBuffer = buffer.slice(buffer.length + result.diff!)
                this.#lastObjectStart = performance.now() + performance.timeOrigin
                this.#lastReceivedOffset = -1 * result.diff!
                this.#currentObjectStatus = ObjectReceiveStatus.Waiting
            } else {
                this.#previousChunkBuffer = new Uint8Array(0)
                this.#lastObjectStart = 0
                this.#lastReceivedOffset = 0
            }

            this.#currentObjectStatus = ObjectReceiveStatus.None
        }

        controller.enqueue(chunk)
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
