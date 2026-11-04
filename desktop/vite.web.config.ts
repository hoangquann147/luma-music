import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { developmentCsp } from './dev-csp';
export default defineConfig({ plugins: [developmentCsp(), react(), tailwindcss()], server: { host: '127.0.0.1' } });
