import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 環境変数を読み込み
  const env = loadEnv(mode, process.cwd(), '')
  
  // バックエンドAPIのURL（デフォルト: http://localhost:3001）
  const apiUrl = env.VITE_API_URL || 'http://localhost:3001'

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
        '/socket.io': {
          target: apiUrl,
          ws: true,
        },
      },
    },
  }
})
