import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { config } from '../config.js'
import { registerRoutes } from './routes/index.js'
import { MemoryNonceStore } from '../auth.js'

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  })

  const origins = config.http.corsOrigin
  await app.register(cors, {
    origin: origins === '*' ? true : origins.split(',').map((o) => o.trim()),
  })

  // Create a shared nonce store for authentication
  const nonceStore = new MemoryNonceStore()
  
  // Backward compatibility flag: if DISABLE_NOTIFICATION_AUTH is set, pass null nonceStore
  const disableAuth = process.env.DISABLE_NOTIFICATION_AUTH === 'true'
  await app.register(registerRoutes, { 
    prefix: '/api', 
    nonceStore: disableAuth ? null : nonceStore 
  })

  app.get('/health', async () => ({ status: 'ok', contract: config.stellar.contractId || null }))

  return app
}
