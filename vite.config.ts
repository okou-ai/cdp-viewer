import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    lib: {
      entry: "src/bundle.ts",
      formats: ["es"],
      fileName: "index",
      cssFileName: "style",
    },
    rollupOptions: {
      external: (id) =>
        /^(react|react-dom|ccstate|signal-timers|lucide-react|@base-ui\/react)(\/|$)/.test(
          id,
        ),
    },
  },
});
