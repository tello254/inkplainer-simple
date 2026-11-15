import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Builds the timeline island (React + @elah/timeline) into ./timeline-dist with
// FIXED file names so index.html can reference them without a manifest.
export default defineConfig({
  plugins: [react()],
  worker: {
    // Elah's export worker is an ES module worker; Vite's default IIFE can't use import.
    format: 'es',
  },
  optimizeDeps: {
    // esbuild's pre-bundle rewrites the worker's new URL(...) reference and breaks it.
    exclude: ['@elah/editor', '@elah/core', '@elah/react', '@elah/timeline', 'mediabunny'],
  },
  build: {
    outDir: 'timeline-dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'timeline-src/index.html',
      output: {
        entryFileNames: 'timeline-app.js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: (asset) => {
          const n = asset.names && asset.names[0] ? asset.names[0] : ''
          return n.endsWith('.css') ? 'timeline-app.css' : 'assets/[name][extname]'
        },
      },
    },
  },
})
