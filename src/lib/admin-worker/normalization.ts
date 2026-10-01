export type WorkerIdentityType = 'domain' | 'github_org' | 'postman_team' | 'rapidapi_org'

export function normalizeWorkerIdentity(type: WorkerIdentityType, value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized.length > 253) throw new Error('worker_identity_invalid')
  if (type === 'domain') {
    const hostname = normalized.replace(/^https?:\/\//, '').split('/')[0].replace(/\.$/, '')
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
      throw new Error('worker_identity_invalid')
    }
    return hostname
  }
  const handle = normalized.replace(/^@/, '')
  if (!/^[a-z0-9](?:[a-z0-9_.-]{0,99})$/.test(handle)) throw new Error('worker_identity_invalid')
  return handle
}

export function normalizeWorkerProductKey(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!normalized || normalized.length > 160) throw new Error('worker_product_key_invalid')
  return normalized
}
