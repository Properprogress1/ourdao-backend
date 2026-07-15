import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { config } from '../config.js'
import { registerRoutes } from './routes/index.js'

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  })

  const origins = config.http.corsOrigin
  await app.register(cors, {
    origin: origins === '*' ? true : origins.split(',').map((o) => o.trim()),
  })

  await app.register(registerRoutes, { prefix: '/api' })

  app.get('/health', async () => ({ status: 'ok', contract: config.stellar.contractId || null }))

  return app
}
