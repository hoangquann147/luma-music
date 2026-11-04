import type { Plugin } from 'vite';

// The React refresh preamble runs inline in development. Production keeps the
// strict policy in index.html. Both dev entry points bind only to loopback.
export function developmentCsp(): Plugin {
  return {
    name: 'luma:local-development-csp',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler: html => html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*\/>/, ''),
    },
  };
}
