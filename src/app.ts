import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { BadRequestError } from './identify/errors.js'
import { normaliseIdentifyBody } from './identify/normalise.js'
import { identify } from './identify/service.js'

export function createApp(): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '16kb' }))

  app.get('/', (_req, res) => {
    res.json({
      service: 'bitespeed-identity-reconciliation',
      endpoint: 'POST /identify',
      health: 'GET /health'
    })
  })

  // Hits the database, so a green /health means the whole path is up, not just Node.
  app.get('/health', async (_req, res) => {
    try {
      const { getPool } = await import('./db/pool.js')
      await getPool().query('SELECT 1')
      res.json({ status: 'ok' })
    } catch (error) {
      res.status(503).json({ status: 'unavailable', error: messageOf(error) })
    }
  })

  app.post('/identify', async (req, res, next) => {
    try {
      res.status(200).json(await identify(normaliseIdentifyBody(req.body)))
    } catch (error) {
      next(error)
    }
  })

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' })
  })

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // A malformed JSON body is the caller's problem, not a 500.
    if (error instanceof BadRequestError || isJsonSyntaxError(error)) {
      res.status(400).json({ error: messageOf(error) })
      return
    }
    console.error('[identify] unhandled', error)
    res.status(500).json({ error: 'Internal server error.' })
  })

  return app
}

function isJsonSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError && 'body' in error
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
