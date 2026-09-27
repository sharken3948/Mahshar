export { NextRequest, NextResponse } from 'next/server.js'
export function after(value: Promise<unknown> | (() => unknown)) { if (typeof value === 'function') void value(); else void value }
