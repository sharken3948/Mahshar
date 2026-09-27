import type { AuthType } from '@/types'

export function buildUpstreamAuthentication(
  validatedUrl: URL,
  authType: AuthType,
  credential?: string,
  authParamName?: string | null,
) {
  const requestUrl = new URL(validatedUrl)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (credential && authType === 'apikey') headers['x-api-key'] = credential
  else if (credential && authType === 'bearer') headers.authorization = `Bearer ${credential}`
  else if (credential && authType === 'queryparam' && authParamName) requestUrl.searchParams.set(authParamName, credential)
  return { requestUrl, headers }
}
