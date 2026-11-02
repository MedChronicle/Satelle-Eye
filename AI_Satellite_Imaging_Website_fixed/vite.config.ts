import { defineConfig, loadEnv } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function figmaAssetResolver() {
  const assetsDir = path.resolve(__dirname, 'src/assets')

  return {
    name: 'figma-asset-resolver',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id.startsWith('figma:asset/')) {
        return path.resolve(assetsDir, id.slice('figma:asset/'.length))
      }
      return null
    },
  }
}

function manualChunks(id: string) {
  if (!id.includes('node_modules')) return undefined
  if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
  if (/[\\/]node_modules[\\/](@radix-ui|lucide-react|motion|framer-motion)[\\/]/.test(id)) return 'vendor-ui'
  if (/[\\/]node_modules[\\/](recharts|d3-[^\\/]+)[\\/]/.test(id)) return 'vendor-charts'
  return 'vendor'
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const isProd = mode === 'production'
  const port = Number(env.VITE_PORT) || 5173

  return {
    plugins: [figmaAssetResolver(), react(), tailwindcss()],

    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src/app'),
        '@assets': path.resolve(__dirname, './src/assets'),
      },
    },

    define: {
      __APP_MODE__: JSON.stringify(mode),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },

    server: {
      port,
      strictPort: false,
      open: false,
      host: env.VITE_HOST === 'true',
      warmup: {
        clientFiles: ['./src/main.tsx', './src/app/**/*.tsx'],
      },
      proxy: env.VITE_API_URL
        ? {
            '/api': {
              target: env.VITE_API_URL,
              changeOrigin: true,
              secure: false,
            },
          }
        : undefined,
    },

    preview: {
      port: port + 1000,
      strictPort: false,
    },

    css: {
      devSourcemap: !isProd,
    },

    esbuild: {
      drop: isProd ? ['console', 'debugger'] : [],
      legalComments: 'none',
    },

    optimizeDeps: {
      include: ['react', 'react-dom'],
    },

    build: {
      target: 'es2022',
      outDir: 'dist',
      assetsInlineLimit: 4096,
      cssCodeSplit: true,
      cssMinify: true,
      sourcemap: isProd ? 'hidden' : true,
      chunkSizeWarningLimit: 800,
      reportCompressedSize: false,
      rollupOptions: {
        output: {
          manualChunks,
          chunkFileNames: 'assets/js/[name]-[hash].js',
          entryFileNames: 'assets/js/[name]-[hash].js',
          assetFileNames: ({ name }) => {
            const ext = name ? path.extname(name).slice(1) : ''
            if (/png|jpe?g|svg|gif|webp|avif|ico/i.test(ext)) return 'assets/img/[name]-[hash][extname]'
            if (/woff2?|ttf|otf|eot/i.test(ext)) return 'assets/fonts/[name]-[hash][extname]'
            if (ext === 'css') return 'assets/css/[name]-[hash][extname]'
            return 'assets/[name]-[hash][extname]'
          },
        },
      },
    },
  }
})
