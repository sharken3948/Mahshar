// Build verification only; never included through NODE_OPTIONS in a deployment.
globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_OFFLINE_BUILD') }
