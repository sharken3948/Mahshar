import 'server-only'
import { isOutboundUrlShapeAllowed } from '@/lib/outbound-fetch'
import { ProviderAuthError } from './provider-auth-config'

export type OAuthProfile = {
  id: string
  token_endpoint: string
  authorization_endpoint?: string
  revocation_endpoint?: string
  resource_origins: string[]
  scopes: string[]
  grants: Array<'client_credentials' | 'authorization_code'>
  client_auth: 'client_secret_basic' | 'client_secret_post' | 'none'
}

/** Operator-managed trust registry. Sellers cannot supply endpoints, scopes, redirects or extra token parameters. */
export function approvedOAuthProfile(id: string, resourceUrl: string, grant: 'client_credentials' | 'authorization_code'): OAuthProfile {
  try {
    const profiles: unknown = JSON.parse(process.env.PROVIDER_OAUTH_PROFILES ?? '[]')
    if (!Array.isArray(profiles) || profiles.length > 32) throw new ProviderAuthError()
    const profile = profiles.find(value => value?.id === id) as OAuthProfile | undefined
    if (!profile || profiles.filter(value => value?.id === id).length !== 1 ||
      !Array.isArray(profile.grants) || !profile.grants.includes(grant) ||
      !['client_secret_basic', 'client_secret_post', 'none'].includes(profile.client_auth) ||
      !Array.isArray(profile.scopes) || profile.scopes.length > 32 || profile.scopes.some(scope =>
        typeof scope !== 'string' || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope)) ||
      !Array.isArray(profile.resource_origins) || !profile.resource_origins.length || profile.resource_origins.length > 16) throw new ProviderAuthError()
    for (const endpoint of [profile.token_endpoint, profile.authorization_endpoint, profile.revocation_endpoint].filter(x => x !== undefined)) {
      if (typeof endpoint !== 'string' || !isOutboundUrlShapeAllowed(endpoint) || new URL(endpoint).search) throw new ProviderAuthError()
    }
    if (!profile.token_endpoint || (grant === 'authorization_code' && !profile.authorization_endpoint) ||
      (grant === 'client_credentials' && profile.client_auth === 'none')) throw new ProviderAuthError()
    if (profile.resource_origins.some(origin => typeof origin !== 'string' || !isOutboundUrlShapeAllowed(origin) || new URL(origin).origin !== origin)) throw new ProviderAuthError()
    if (!profile.resource_origins.includes(new URL(resourceUrl).origin)) throw new ProviderAuthError()
    return profile
  } catch { throw new ProviderAuthError() }
}
