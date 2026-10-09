import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  createDiscoveryClient,
  DiscoverySourceError,
  publicListingSummary,
} from './discovery-client'

export const searchApisInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(10_000).default(0),
}).strict()

export const getApiInputSchema = z.object({
  api_id: z.string().uuid(),
}).strict()

type McpHandlerOptions = Parameters<typeof createDiscoveryClient>[0]

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

function toolError(code: 'api_not_found' | 'discovery_unavailable', details: Record<string, unknown> = {}) {
  return {
    ...result({ error: code, ...details }),
    isError: true,
  }
}

export function createMahsharMcpServer(options: McpHandlerOptions = {}) {
  const server = new McpServer(
    { name: 'mahshar-public-discovery', version: '1.0.0' },
    {
      maxToolInputElements: 8,
      capabilities: { tools: { listChanged: false } },
    },
  )
  const discovery = createDiscoveryClient(options)

  server.registerTool('search_apis', {
    title: 'Search Mahshar APIs',
    description: 'Search or page public active Mahshar API listing summaries.',
    inputSchema: searchApisInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset }) => {
    try {
      const page = await discovery.page(limit, offset)
      const apis = page.apis.map(publicListingSummary)

      return result({
        apis,
        pagination: {
          ...page.pagination,
          returned: apis.length,
        },
      })
    } catch (error) {
      if (error instanceof DiscoverySourceError) return toolError('discovery_unavailable')
      throw error
    }
  })

  server.registerTool('get_api', {
    title: 'Get Mahshar API',
    description: 'Return the public Mahshar agent execution contract for one active listing.',
    inputSchema: getApiInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ api_id }) => {
    try {
      const api = await discovery.find(api_id)
      return api ? result({ api }) : toolError('api_not_found', { api_id })
    } catch (error) {
      if (error instanceof DiscoverySourceError) return toolError('discovery_unavailable')
      throw error
    }
  })

  return server
}

export function createMahsharMcpHandler(options: McpHandlerOptions = {}) {
  return createMcpHandler(
    () => createMahsharMcpServer(options),
    {
      legacy: 'reject',
      responseMode: 'json',
      maxSubscriptions: 0,
      maxRequestBodySize: 16 * 1024,
      onerror(error) {
        console.error('[mcp] protocol error:', error.message)
      },
    },
  )
}
