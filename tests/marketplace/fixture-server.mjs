// Native import() sees tsx's CommonJS fixture as a default export. Expose the
// server module's actual named contract for the SEO reader's dynamic import.
import fixture from './fixtures.ts'
export const createServiceClient = fixture.createServiceClient
