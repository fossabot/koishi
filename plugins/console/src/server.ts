import { Adapter, App, Context, Logger, noop, version, Dict, WebSocketLayer } from 'koishi'
import { resolve, extname } from 'path'
import { promises as fs, Stats, createReadStream } from 'fs'
import WebSocket from 'ws'
import open from 'open'
import { v4 } from 'uuid'
import type { ViteDevServer } from 'vite'
import {} from '@koishijs/cli'

interface BaseConfig {
  devMode?: boolean
  uiPath?: string
}

export interface Config extends BaseConfig {
  root?: string
  open?: boolean
  selfUrl?: string
  apiPath?: string
}

export interface ClientConfig extends Required<BaseConfig> {
  version: string
  database: boolean
  endpoint: string
  extensions: string[]
}

const logger = new Logger('status')

export class SocketHandle {
  readonly app: App
  readonly id: string

  constructor(webui: StatusServer, public socket: WebSocket) {
    this.app = webui.ctx.app
    webui.handles[this.id = v4()] = this
  }

  send(type: string, body?: any) {
    this.socket.send(JSON.stringify({ type, body }), noop)
  }

  async validate() {
    return this.app.serial('status/validate', this)
  }
}

export interface DataSource<T = any> {
  get(forced?: boolean): Promise<T>
}

export namespace DataSource {
  export interface Library extends Dict<DataSource> {}
}

export class StatusServer extends Adapter {
  readonly sources: DataSource.Library = {}
  readonly global: ClientConfig
  readonly entries: Dict<string> = {}
  readonly handles: Dict<SocketHandle> = {}
  readonly platform = 'status'

  private vite: ViteDevServer
  private readonly server: WebSocketLayer
  private readonly [Context.current]: Context

  constructor(ctx: Context, public config: Config) {
    super(ctx.app, config)

    this.ctx.bots.adapters.status = this
    const { apiPath, uiPath, devMode, selfUrl } = config
    const endpoint = selfUrl + apiPath
    this.global = { uiPath, endpoint, devMode, extensions: [], database: false, version }

    if (config.root === undefined) {
      const filename = require.resolve('@koishijs/ui-console/package.json')
      config.root = resolve(filename, '..', devMode ? 'src' : 'dist')
    }

    this.server = ctx.router.ws(apiPath, this.onConnection)

    ctx.on('service/database', () => {
      this.global.database = !!ctx.database
    })
  }

  broadcast(type: string, body: any) {
    if (!this?.server.clients.size) return
    const data = JSON.stringify({ type, body })
    this.server.clients.forEach((socket) => socket.send(data, noop))
  }

  private triggerReload() {
    this.global.extensions = Object.entries(this.entries).map(([name, filename]) => {
      return this.config.devMode ? '/vite/@fs/' + filename : `./${name}`
    })
    this.vite?.ws.send({ type: 'full-reload' })
  }

  addEntry(filename: string) {
    const ctx = this[Context.current]
    let { state } = ctx
    while (state && !state.name) state = state.parent
    const hash = Math.floor(Math.random() * (16 ** 8)).toString(16).padStart(8, '0')
    const key = `${state?.name || 'entry'}-${hash}.js`
    this.entries[key] = filename
    this.triggerReload()
    ctx.on('disconnect', () => {
      delete this.entries[key]
      this.triggerReload()
    })
  }

  addListener(event: string, listener: StatusServer.Listener) {
    StatusServer.listeners[event] = listener
  }

  connect() {}

  async start() {
    if (!this.config.root) return
    if (this.config.devMode) await this.createVite()
    this.serveAssets()

    if (this.config.open) {
      const { host, port } = this.ctx.app.options
      open(`http://${host || 'localhost'}:${port}${this.config.uiPath}`)
    }
  }

  stop() {
    this.server.close()
  }

  private onConnection = (socket: WebSocket) => {
    const channel = new SocketHandle(this, socket)

    for (const key in this.sources) {
      this.sources[key].get().then((value) => {
        socket.send(JSON.stringify({ type: 'data', body: { key, value } }))
      })
    }

    socket.on('message', async (data) => {
      const { type, body } = JSON.parse(data.toString())
      const method = StatusServer.listeners[type]
      if (method) {
        await method.call(channel, body)
      } else {
        logger.info(type, body)
      }
    })
  }

  private serveAssets() {
    const { uiPath, root } = this.config

    this.ctx.router.get(uiPath + '(/.+)*', async (ctx, next) => {
      // add trailing slash and redirect
      if (ctx.path === uiPath && !uiPath.endsWith('/')) {
        return ctx.redirect(ctx.path + '/')
      }
      const name = ctx.path.slice(uiPath.length).replace(/^\/+/, '')
      const sendFile = (filename: string) => {
        ctx.type = extname(filename)
        return ctx.body = createReadStream(filename)
      }
      if (name.startsWith('assets/')) {
        const key = name.slice(7)
        if (this.entries[key]) return sendFile(this.entries[key])
      }
      const filename = resolve(root, name)
      if (!filename.startsWith(root) && !filename.includes('node_modules')) {
        return ctx.status = 403
      }
      const stats = await fs.stat(filename).catch<Stats>(noop)
      if (stats?.isFile()) return sendFile(filename)
      const ext = extname(filename)
      if (ext && ext !== '.html') return next()
      const template = await fs.readFile(resolve(root, 'index.html'), 'utf8')
      ctx.type = 'html'
      ctx.body = await this.transformHtml(template)
    })
  }

  private async transformHtml(template: string) {
    if (this.vite) template = await this.vite.transformIndexHtml(this.config.uiPath, template)
    const headInjection = `<script>KOISHI_CONFIG = ${JSON.stringify(this.global)}</script>`
    return template.replace('</title>', '</title>' + headInjection)
  }

  private async createVite() {
    const { root } = this.config
    const { createServer } = require('vite') as typeof import('vite')
    const { default: pluginVue } = require('@vitejs/plugin-vue') as typeof import('@vitejs/plugin-vue')

    this.vite = await createServer({
      root: root,
      base: '/vite/',
      server: {
        middlewareMode: true,
        fs: {
          strict: true,
        },
      },
      plugins: [pluginVue()],
      resolve: {
        alias: {
          '~/client': root,
          '~/variables': root + '/index.scss',
        },
      },
    })

    this.ctx.router.all('/vite(/.+)*', (ctx) => new Promise((resolve) => {
      this.vite.middlewares(ctx.req, ctx.res, resolve)
    }))

    this.ctx.on('disconnect', () => this.vite.close())
  }
}

export namespace StatusServer {
  export type Listener = (this: SocketHandle, payload: any) => Promise<void>
  export const listeners: Dict<Listener> = {}
}