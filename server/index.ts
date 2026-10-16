import { loadConfig } from './config.ts';
import { createApp } from './app.ts';

const cfg = loadConfig();
const { server } = createApp(cfg);

server.listen(cfg.port, cfg.host, () => {
  console.log(`OS Practice Exam Server listening at http://${cfg.host}:${cfg.port}/practice`);
  console.log(`Database path: ${cfg.dbPath}`);
  console.log(`Import UI:     http://${cfg.host}:${cfg.port}/import`);
});
