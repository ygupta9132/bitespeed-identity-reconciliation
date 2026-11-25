/** A request the caller can fix. Surfaces as HTTP 400. */
export class BadRequestError extends Error {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

/**
 * An invariant the database should have made impossible. Surfaces as HTTP 500,
 * because the caller cannot do anything about it and we want it in the logs.
 */
export class InvariantError extends Error {
  readonly status = 500
  constructor(message: string) {
    super(message)
    this.name = 'InvariantError'
  }
}
