import { defineConfig } from "vite";

export default defineConfig({
  root: "demo",
  base: "/cdp-viewer/",
  build: {
    outDir: "../dist/demo",
    emptyOutDir: true,
  },
  plugins: [
    {
      name: "demo-revision",
      transformIndexHtml: () => [
        {
          tag: "meta",
          attrs: {
            name: "cdp-viewer-revision",
            content: process.env.GITHUB_SHA ?? "local",
          },
          injectTo: "head",
        },
      ],
    },
  ],
});
