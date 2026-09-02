// src/transports/healthcheck.ts
import { get } from 'node:http';

/**
 * ECS container-level health check, invoked via exec-form `CMD` in the task definition
 * (e.g. `["node", "dist/transports/healthcheck.js"]`). The distroless runtime image has
 * no shell and no wget/curl, so a `CMD-SHELL wget ... /health` (as used elsewhere, e.g.
 * the Nuxt image) can't work here — this is a dependency-free stand-in that only needs
 * the Node runtime already present in the image.
 */
function main(): void {
  const port = Number(process.env.PORT) || 3000;
  const req = get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
  req.on('timeout', () => {
    req.destroy();
    process.exit(1);
  });
  req.on('error', () => {
    process.exit(1);
  });
}

main();
