import { defineConfig } from 'vite';

// base 使用相对路径，便于部署到任意子路径 / 静态托管。
// 本地 http://localhost:5173 为安全上下文，可正常使用麦克风。
// 移动端通过局域网 IP 访问时需 HTTPS（浏览器安全策略），请部署为 https 站点后使用。
export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
