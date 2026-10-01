import { NextResponse, type NextRequest } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'
import { workerCommandError } from '@/lib/admin-worker/http'
import { startWorkerCommand } from '@/lib/admin-worker/runtime'

export const runtime = 'nodejs'

export const POST = withAdmin(async (_request: NextRequest) => {
  try { return NextResponse.json(await startWorkerCommand('start'), { status: 202 }) }
  catch (error) { return workerCommandError(error, 'worker_start_unavailable') }
})
