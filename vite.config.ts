import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  base: '/IBM_HACK/',
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:7142' } },
})
