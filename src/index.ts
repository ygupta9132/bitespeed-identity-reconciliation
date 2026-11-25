import 'dotenv/config'
import { createApp } from './app.js'
import { migrate } from './db/migrate.js'
import { closePool } from './db/pool.js'

const port = Number(process.env.PORT ?? 3000)

async function main(): Promise<void> {
  // The schema script is idempotent, so a fresh deploy against an empty database comes
  // up serving requests instead of 500ing until someone runs a command by hand.
  await migrate()

  const server = createApp().listen(port, () => {
    console.log(`listening on :${port}`)
  })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      server.close(() => {
        closePool().finally(() => process.exit(0))
      })
    })
  }
}

main().catch((error) => {
  console.error('failed to start', error)
  process.exit(1)
})
