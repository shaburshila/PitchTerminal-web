import { defineConfig, loadEnv } from 'vite';
import { execSync } from 'node:child_process';

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Pin Sentry release to the git SHA at build time when the deploy
  // pipeline hasn't supplied VITE_APP_VERSION explicitly.
  process.env.VITE_APP_VERSION = env.VITE_APP_VERSION || gitSha();

  return {
    server: {
      proxy: { '/api': 'http://localhost:5000' },
      port: 5173,
    },
    build: { outDir: 'dist' },
  };
});
