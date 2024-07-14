import { forwardRef, useEffect } from "react"
import type { Ref } from "react"
import useBackground from "./useBackground"

const DASHPlayer = forwardRef(function (props: React.VideoHTMLAttributes<HTMLVideoElement>, ref: Ref<HTMLVideoElement>) {
    const canvasRef = useBackground(ref)

    return (
        <div
            className="relative aspect-video w-fit"
            style={{
                height: "min(100vw * 9 / 16, 50vh)"
            }}
        >
            <video ref={ref} {...props} className="relative inset-0 z-10 h-full w-full scale-90 object-cover" />
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-cover opacity-50 blur-2xl" />
        </div>
    )
})

const MOQPlayer = forwardRef(function (props: React.CanvasHTMLAttributes<HTMLCanvasElement>, ref: Ref<HTMLCanvasElement>) {
    const canvasRef = useBackground(ref)

    return (
        <div
            className="relative aspect-video w-fit"
            style={{
                height: "min(100vw * 9 / 16, 50vh)"
            }}
        >
            <canvas ref={ref} {...props} className="relative inset-0 z-10 h-full w-full scale-90 object-cover" />
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-cover opacity-50 blur-2xl" />
        </div>
    )
})

export { DASHPlayer, MOQPlayer }
