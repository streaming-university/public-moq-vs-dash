import type { Ref, RefObject } from "react"
import { useRef } from "react"
import { useMedia, useRafLoop } from "react-use"

export default function useBackground(src: Ref<HTMLVideoElement> | Ref<HTMLCanvasElement>) {
    const reducedMotion = useMedia("(prefers-reduced-motion: reduce)")
    const ref = useRef<HTMLCanvasElement>(null)

    useRafLoop(() => {
        const video = (src as RefObject<HTMLElement>).current
        if (!video || reducedMotion || !ref.current) return

        // Get render context
        const ctx = ref.current.getContext("2d")!
        ctx.filter = "blur(1px)"

        // Update canvas size
        ref.current.width = 16
        ref.current.height = 9

        // Draw video on canvas
        ctx.drawImage(video as any, 0, 0, ref.current.width, ref.current.height)
    }, true)

    return ref
}
