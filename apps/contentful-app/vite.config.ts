import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// WebKit browsers such as Safari block an http://localhost frame inside
// Contentful's HTTPS web app as mixed content, so `pnpm dev:https` serves App
// Dev Mode over HTTPS. The self-signed certificate is trusted once by hand, so
// it lives outside node_modules and lasts Apple's 825-day maximum.
// See docs/local-development.md.
const ssl = () =>
  basicSsl({
    name: 'AI Translator for Contentful development',
    certDir: fileURLToPath(new URL('.cert', import.meta.url)),
    ttlDays: 825,
  });

export default defineConfig(({ mode }) => ({
  base: './',
  build: { outDir: 'build', license: { fileName: 'THIRD_PARTY_LICENSES.md' } },
  server: { port: 3000, strictPort: true },
  plugins: mode === 'https' ? [ssl()] : [],
}));
