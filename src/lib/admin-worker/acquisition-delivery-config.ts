import 'server-only'

/** This flag never creates recipient permission or database channel approval. */
export function brevoAcquisitionEnabled(): boolean {
  return process.env.ADMIN_ACQUISITION_BREVO_ENABLED === 'true'
    && process.env.ADMIN_ACQUISITION_MODE === 'true'
    && process.env.ADMIN_ACQUISITION_CONTINUOUS === 'true'
    && process.env.ADMIN_ACQUISITION_CANARY !== 'true'
    && process.env.MAINNET_MODE === 'true' && Boolean(process.env.BREVO_API_KEY?.trim())
}
