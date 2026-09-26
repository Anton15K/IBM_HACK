import { buildApp } from './app.js';

const PORT = parseInt(process.env.PORT ?? '7142', 10);
const HOST = '127.0.0.1';

const app = buildApp({ logger: { level: 'info' } });

app.listen({ port: PORT, host: HOST }, (err: Error | null, address: string) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`TeamWeave server listening at ${address}`);
});
