export const INVITATION_TEMPLATE_VERSION = 'mahshar-provider-invitation-v1'
export const INVITATION_SUBJECT = 'Invitation to list your API on Mahshar'

export type InvitationVariables = {
  company: string | null
  product: string | null
  companyVerified: boolean
  productVerified: boolean
}
export type TemplateSkipReason = 'template_company_missing' | 'template_product_missing'
  | 'template_company_invalid' | 'template_product_invalid' | 'template_company_unverified' | 'template_product_unverified'

export function validInvitationName(value: string): boolean {
  return value === value.trim() && value.length <= 200 && /[\p{L}\p{N}]/u.test(value)
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>@]/u.test(value) && !/:\/\//.test(value)
    && !/\[(?:company|api product)\]/i.test(value)
    && !/^(?:unknown|n\/?a|none|null|undefined|tbd|\[company\]|\[api product\])$/i.test(value)
}

export function renderInvitationTemplate(variables: InvitationVariables):
  { ok: true; draft: { subject: string; body: string; generator: 'template'; templateVersion: typeof INVITATION_TEMPLATE_VERSION } }
  | { ok: false; reason: TemplateSkipReason } {
  const { company, product } = variables
  if (!company?.trim()) return { ok: false, reason: 'template_company_missing' }
  if (!product?.trim()) return { ok: false, reason: 'template_product_missing' }
  if (!validInvitationName(company)) return { ok: false, reason: 'template_company_invalid' }
  if (!validInvitationName(product)) return { ok: false, reason: 'template_product_invalid' }
  if (!variables.companyVerified) return { ok: false, reason: 'template_company_unverified' }
  if (!variables.productVerified) return { ok: false, reason: 'template_product_unverified' }
  return { ok: true, draft: { subject: INVITATION_SUBJECT, generator: 'template', templateVersion: INVITATION_TEMPLATE_VERSION,
    body: `Hello ${company} team,

I'm reaching out from Mahshar, an API marketplace built on Arc Mainnet.

Mahshar enables developers, individual users, and autonomous AI agents to discover and access APIs through pay-per-call USDC payments.

We'd like to invite ${company} to explore listing ${product} on Mahshar.

You can choose which APIs or endpoints to make available, with no need to migrate your existing infrastructure.

You can learn more at https://mahshar.xyz/providers.

Best regards,
Mahshar Team
support@mahshar.xyz` } }
}
