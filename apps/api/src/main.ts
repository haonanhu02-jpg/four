import { createApp } from './bootstrap';
import { AppConfig } from './config';

async function main(): Promise<void> {
  const app = await createApp();
  const config = app.get(AppConfig);
  await app.listen(config.port, '0.0.0.0');
  console.log(`API listening on http://127.0.0.1:${config.port}/api`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'API failed to start');
  process.exitCode = 1;
});
