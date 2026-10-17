export type PendingEmail = { id: string; apiName: string; emailAddress: string }
export type PendingEmails = { items: PendingEmail[]; nextCursor: string | null }
export const MAIL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
