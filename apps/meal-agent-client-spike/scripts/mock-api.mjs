import { createServer } from 'node:http'

const host = process.env.MEAL_AGENT_MOCK_API_HOST ?? '127.0.0.1'
const port = Number(process.env.MEAL_AGENT_MOCK_API_PORT ?? '8787')

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MEAL_AGENT_MOCK_API_PORT 必须是有效端口号')
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/spike/today') {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json; charset=utf-8'
    })
    response.end(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        message: 'Meal Agent 本地模拟 API 已连通',
        source: 'local-mock'
      })
    )
    return
  }

  response.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8'
  })
  response.end(JSON.stringify({ error: 'not_found' }))
})

server.listen(port, host, () => {
  console.info(`Meal Agent spike mock API: http://${host}:${port}`)
})

const shutdown = () => {
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
