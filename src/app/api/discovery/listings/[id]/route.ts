import { NextRequest, NextResponse } from 'next/server'
import { withAdmin } from '@/lib/admin-auth'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string }> }

export const PATCH = withAdmin(async (_request: NextRequest, _admin, _context: Context) =>
  NextResponse.json({ error: 'legacy_discovery_disabled' }, { status: 410 }))

export const DELETE = withAdmin(async (_request: NextRequest, _admin, _context: Context) =>
  NextResponse.json({ error: 'legacy_discovery_disabled' }, { status: 410 }))
