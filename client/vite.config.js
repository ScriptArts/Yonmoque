import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import process from 'node:process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 環境変数を読み込み
  const env = loadEnv(mode, process.cwd(), '')
  
  // バックエンドAPIのURL（デフォルト: wrangler dev の http://localhost:8787）
  const apiUrl = env.VITE_API_URL || 'http://localhost:8787'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      proxy: {
        '/api': apiUrl,
        '/ws': {
          target: apiUrl,
          ws: true,
        },
      },
    },
  }
})
