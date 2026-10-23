import type { AuthType } from '@/types'
import { staticAuthentication } from './provider-auth-config'

export function buildUpstreamAuthentication(
  validatedUrl: URL,
  authType: AuthType,
  credential?: string,
  authParamName?: string | null,
) {
  const requestUrl = new URL(validatedUrl)
  const authentication = staticAuthentication(authType, credential, authParamName)
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authentication.headers }
  if (authType === 'queryparam' && credential && authParamName) requestUrl.searchParams.set(authParamName, credential)
  return { requestUrl, headers, secrets: authentication.secrets }
}
