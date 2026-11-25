export type LinkPrecedence = 'primary' | 'secondary'

/** One row of the `contact` table, in camelCase. */
export type ContactRow = {
  id: number
  phoneNumber: string | null
  email: string | null
  linkedId: number | null
  linkPrecedence: LinkPrecedence
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

/** A validated request body. At least one of the two is always non-null. */
export type IdentifyInput = {
  email: string | null
  phoneNumber: string | null
}

/**
 * The response shape is copied from the task brief verbatim, including the
 * misspelling of `primaryContatctId`.
 *
 * This is deliberate and there is a test asserting the misspelling. The brief uses
 * that exact key in both of its response examples, so a client written against the
 * brief would break if we silently corrected it.
 */
export type IdentifyResponse = {
  contact: {
    primaryContatctId: number
    emails: string[]
    phoneNumbers: string[]
    secondaryContactIds: number[]
  }
}
