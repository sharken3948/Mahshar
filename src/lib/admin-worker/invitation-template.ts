import { resolveOfficialNames, type OfficialNameEvidence } from './invitation-names'
export { validInvitationName } from './invitation-names'
export const INVITATION_TEMPLATE_VERSION = 'mahshar-provider-invitation-v2'
export const INVITATION_TEMPLATE_VERSIONS = ['mahshar-provider-invitation-v1', INVITATION_TEMPLATE_VERSION] as const
export const INVITATION_SUBJECT = 'Invitation to list your API on Mahshar'

export type InvitationVariables = {
  company: string | null
  product: string | null
  domain?: string
  namingEvidence?: OfficialNameEvidence[]
  companyVerified: boolean
  productVerified: boolean
}
export type TemplateSkipReason = 'template_company_missing' | 'template_product_missing'
  | 'template_company_invalid' | 'template_product_invalid' | 'template_company_unverified' | 'template_product_unverified'

export function renderInvitationTemplate(variables: InvitationVariables):
  { ok: true; draft: { subject: string; body: string; generator: 'template'; templateVersion: typeof INVITATION_TEMPLATE_VERSION } }
  | { ok: false; reason: TemplateSkipReason } {
  const { company, product } = resolveOfficialNames(variables.domain ?? '', variables.namingEvidence)
  return { ok: true, draft: { subject: INVITATION_SUBJECT, generator: 'template', templateVersion: INVITATION_TEMPLATE_VERSION,
    body: `${company ? `Hello ${company} team,` : 'Hello team,'}

I'm reaching out from Mahshar, an API marketplace built on Arc Mainnet.

Mahshar enables developers, individual users, and autonomous AI agents to discover and access APIs through pay-per-call USDC payments.

${product ? `We'd like to invite ${company ?? 'your team'} to explore listing ${product} on Mahshar.` : "We'd like to invite your team to explore listing one of your APIs on Mahshar."}

You can choose which APIs or endpoints to make available, with no need to migrate your existing infrastructure.

You can learn more at https://mahshar.xyz/providers.

Best regards,
Mahshar Team
support@mahshar.xyz` } }
}
