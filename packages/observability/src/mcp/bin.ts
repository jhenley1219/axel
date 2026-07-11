#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SessionReader } from '../SessionReader.js'
import { createObservabilityMcpServer } from './server.js'

const dir = process.env.AXEL_OBSERVE_DIR ?? './data/observability'
const reader = new SessionReader(dir)
const server = createObservabilityMcpServer(reader)
const transport = new StdioServerTransport()

server.connect(transport).catch(err => {
  console.error('[axel-observe] failed to start MCP server:', err)
  process.exit(1)
})
