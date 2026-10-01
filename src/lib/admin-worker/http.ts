import 'server-only'
import { NextResponse } from 'next/server'
import { WorkerControlError } from './control'

export function workerCommandError(error: unknown, fallback: string): NextResponse {
  if (error instanceof WorkerControlError) {
    return NextResponse.json({ error: error.code }, { status: error.status })
  }
  console.error(`[admin-worker] ${fallback}`, error)
  return NextResponse.json({ error: fallback }, { status: 503 })
}
