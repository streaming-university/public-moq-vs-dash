import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
    plugins: [react()],

    // Uncomment the following lines to configure the dev server and the preview server to use HTTPS
    server: {
        host: true,
        port: 5173 /*,
        https: {
            cert: "/etc/tls/cert",
            key: "/etc/tls/key"
        }*/
    },
    preview: {
        host: true,
        port: 5173 /*,
        https: {
            cert: "/etc/tls/cert",
            key: "/etc/tls/key"
        }*/
    }
})
