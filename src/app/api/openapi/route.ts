import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const document = await readFile(join(process.cwd(), 'openapi.yaml'), 'utf8')
    return new Response(document, {
      headers: {
        'Content-Type': 'application/yaml; charset=utf-8',
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
      },
    })
  } catch {
    return Response.json({ error: 'openapi_unavailable' }, { status: 503 })
  }
}
