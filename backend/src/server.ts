import type { Server } from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './infrastructure/config.js';
import {
  closeDatabase,
  verifyDatabaseConnection,
} from './infrastructure/database/drizzle/client.js';
import { authRouter } from './presentation/controllers/auth.controller.js';
import { businessRouter } from './presentation/controllers/business.controller.js';
import { customerRouter } from './presentation/controllers/customer.controller.js';
import { orderRouter } from './presentation/controllers/order.controller.js';
import { categoryRouter } from './presentation/controllers/category.controller.js';
import { productRouter } from './presentation/controllers/product.controller.js';
import { invitationRouter, teamRouter } from './presentation/controllers/team.controller.js';
import { closeInviteQueue } from './infrastructure/queue/invite-queue.js';
import { closeRateLimitStore } from './presentation/middlewares/invite-rate-limit.middleware.js';
import {
  globalRateLimiter,
  loginAccountRateLimiter,
  loginIpRateLimiter,
  refreshRateLimiter,
  registerRateLimiter,
} from './presentation/middlewares/rate-limit.middleware.js';

const app = express();
const port = Number(config.PORT);
const shutdownTimeoutMs = 10_000;

// TLS terminates at the host's proxy on every supported platform, so trust a
// single hop to keep req.ip and req.protocol honest. Raise it if a CDN also
// fronts the host.
app.set('trust proxy', 1);
app.use(helmet());

const corsOrigins = config.CORS_ORIGINS.split(',');
app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

// Rate limits run after body parsing so the login limiter can key on the
// submitted email, and before the routers so rejected requests do no work.
app.use(globalRateLimiter);
app.use('/api/auth/login', loginIpRateLimiter, loginAccountRateLimiter);
app.use('/api/auth/register', registerRateLimiter);
app.use('/api/auth/refresh', refreshRateLimiter);

app.use('/api/auth', authRouter);
app.use('/api/business', businessRouter);
app.use('/api/customers', customerRouter);
app.use('/api/orders', orderRouter);
app.use('/api/categories', categoryRouter);
app.use('/api/products', productRouter);
app.use('/api/team', teamRouter);
app.use('/api/invitations', invitationRouter);

app.get('/health', (_request, response) => {
  response.status(200).json({
    success: true,
    data: { status: 'ok' },
    message: 'Backend is healthy',
  });
});

/** Stop accepting connections and close the pool when the host stops the process. */
function installShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  const shutdown = async (signal: 'SIGTERM' | 'SIGINT'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`${signal} received, shutting down`);
    // A stray handle must not block a container restart. The deadline is
    // unref'd, so a clean drain exits on its own first.
    const deadline = setTimeout(() => {
      console.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, shutdownTimeoutMs);
    deadline.unref();

    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // The queue and the rate limit store hold Redis connections, so they close
    // with the database pool before the process exits.
    for (const [label, close] of [
      ['invite queue', closeInviteQueue],
      ['rate limit store', closeRateLimitStore],
      ['database', closeDatabase],
    ] as const) {
      try {
        await close();
      } catch (error) {
        console.error(`Failed to close the ${label}:`, error);
      }
    }
    console.log('Shutdown complete');
    process.exitCode = 0;
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

async function startServer(): Promise<void> {
  try {
    await verifyDatabaseConnection();
    console.log('Database connected successfully');
  } catch (error) {
    console.error('Failed to connect to database:', error);
    await closeDatabase().catch(() => undefined);
    // Leave now instead of setting exitCode: a failed pool keeps a retry timer
    // alive, which would keep the process running without ever listening.
    process.exit(1);
  }

  const server = app.listen(port, () => {
    console.log(`Backend listening on port ${port}`);
  });
  installShutdownHandlers(server);
}

void startServer();
