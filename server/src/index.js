import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { buildRouter } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env from server/.env regardless of the process working directory,
// then fall back to any .env in the current directory. This keeps Galileo/Vault
// config working whether the app is started from repo root or from server/.
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();
const PORT = Number(process.env.PORT || 3001);

// Safety net: never let a stray async error take down the whole server.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[uncaughtException]', err);
});
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true,
  })
);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api', buildRouter());

// Central error handler. Keeps Vault error messages but hides stack traces.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  // eslint-disable-next-line no-console
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err.message);
  res.status(status).json({
    error: err.message || 'Unexpected server error',
    ...(err.vaultErrors ? { vaultErrors: err.vaultErrors } : {}),
  });
});

// In production, serve the built client.
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Vault RIM lifecycle tool API listening on port ${PORT}`);
});

export default app;
