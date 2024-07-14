/** @type {import('tailwindcss').Config} */
export default {
    content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
    theme: {
        extend: {
            fontFamily: {
                sans: ["Nunito", "sans-serif"],
                anton: ["Anton", "sans-serif"],
                display: ["Rubik Doodle Shadow", "sans-serif"]
            },
            colors: {
                dash: "#1B60F8",
                moq: "#d66629"
            }
        }
    },
    plugins: []
}
