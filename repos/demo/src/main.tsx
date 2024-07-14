import React, { useMemo, useState } from "react"
import ReactDOM from "react-dom/client"
import App from "./App.tsx"
import { RouterProvider, createBrowserRouter } from "react-router-dom"
import { BaseSynchroniserSnapshot, MetricSynchroniser, MetricSynchroniserContext, MetricsContext } from "./lib/internal/synchroniser.ts"
import { useRafLoop } from "react-use"
import { SynchroniserSnapshot } from "./lib/internal/types.ts"
import Cockpit from "./Cockpit.tsx"
import "./index.css"

export const Links = () => (
    <div className="flex flex-col items-center gap-4">
        <a className="border-2 border-white bg-red-400 p-4" href="/moq">
            MOQ
        </a>
        <a className="border-2 border-white bg-red-400 p-4" href="/dash">
            DASH
        </a>
        <a className="border-2 border-white bg-red-400 p-4" href="/cockpit">
            Cockpit
        </a>
    </div>
)

export const MetricContainer = ({ children }: { children: React.ReactNode }) => {
    // Metrics synchroniser
    const ms = useMemo(() => new MetricSynchroniser(), [])

    // Render loop
    const [data, setData] = useState<SynchroniserSnapshot>(BaseSynchroniserSnapshot)
    useRafLoop(() => setData(Object.assign({}, ms.metrics)), true)

    return (
        <MetricSynchroniserContext.Provider value={ms}>
            <MetricsContext.Provider value={data}>{children}</MetricsContext.Provider>
        </MetricSynchroniserContext.Provider>
    )
}

const router = createBrowserRouter([
    {
        path: "/moq",
        element: <App mode="moq" />
    },
    {
        path: "/dash",
        element: <App mode="dash" />
    },
    {
        path: "/cockpit",
        element: <Cockpit />
    },
    {
        path: "/",
        element: <Links />
    }
])

ReactDOM.createRoot(document.getElementById("root")!).render(
    // <React.StrictMode>
        <MetricContainer>
            <RouterProvider router={router} />
        </MetricContainer>
    // </React.StrictMode>
)
