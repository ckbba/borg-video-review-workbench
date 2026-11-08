// Starts the dev server with a chosen engine, the same on Windows and macOS (no `VAR=x cmd` shell syntax).
//   npm run swap:dev                         demo (mock, free)        port 5182
//   npm run swap:dev -- borg                 博观 Seedance 2.5
//   npm run swap:dev -- borg minimax-h3-max  博观 MiniMax H3 Max
//   npm run swap:dev -- borg minimax-h3-max 5183
//   npm run swap:dev -- borg minimax-h3-max 5182 image-2.5-flare 480p   (image model, video size)
//   npm run swap:dev -- grok                 65535 Grok Imagine video (previews still on 博观)
//   npm run swap:dev -- grok grok-imagine-video-1.5-preview 5182
// Keys (e.g. S65535_API_KEY) are read from .env.local in the project root (KEY=value per line, not committed).
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const [provider = 'mock', videoModel, port = '5182', imageModel, videoSize] = process.argv.slice(2);
const local = fs.existsSync('.env.local') ? Object.fromEntries(fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .map(l => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map(m => [m[1], m[2]])) : {};
const grok = provider === 'grok';
const env = { ...local, ...process.env, SWAP_PROVIDER: grok ? 'borg' : provider, ...(grok ? { SWAP_VIDEO: 'grok' } : {}),
  ...(videoModel ? { [grok ? 'SWAP_GROK_VIDEO_MODEL' : 'SWAP_BORG_VIDEO_MODEL']: videoModel } : {}),
  ...(imageModel ? { SWAP_BORG_IMAGE_MODEL: imageModel } : {}), ...(videoSize ? { SWAP_BORG_VIDEO_SIZE: videoSize } : {}) };
console.log(`swap: ${provider}${videoModel ? ' / ' + videoModel : ''} → http://127.0.0.1:${port}/swap.html`);
spawn('npx', ['vite', '--host', '127.0.0.1', '--port', port, '--strictPort'], { env, stdio: 'inherit', shell: true })
  .on('exit', code => process.exit(code ?? 0));
