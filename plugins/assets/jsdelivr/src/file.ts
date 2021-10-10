import { Tables, noop } from 'koishi'
import { unlink } from 'fs/promises'
import { join } from 'path'
import JsdelivrAssets from './index'

declare module 'koishi' {
  interface Tables {
    jsdelivr: File
  }
}

export interface FileBase {
  hash: string
  name: string
  size: number
}

export interface File extends FileBase {
  id: number
  branch: number
}

Tables.extend('jsdelivr', {
  id: 'integer',
  hash: 'string',
  name: 'string',
  branch: 'integer',
  size: 'integer',
}, {
  autoInc: true,
})

export interface Task extends File {}

export class Task {
  constructor(private assets: JsdelivrAssets, file: FileBase) {
    Object.assign(this, file)
  }

  public resolvers: ((data: string) => void)[]
  public rejectors: ((reason: any) => void)[]

  get filename() {
    return `${this.hash}-${this.name}`
  }

  get tempPath() {
    return join(this.assets.config.tempDir, this.hash)
  }

  get savePath() {
    return join(this.assets.config.git.baseDir, this.filename)
  }

  resolve() {
    const url = this.assets.toPublicUrl(this)
    for (const callback of this.resolvers) {
      callback(url)
    }
  }

  async reject(error: any) {
    for (const callback of this.rejectors) {
      callback(error)
    }
    await Promise.all([
      unlink(this.tempPath).catch(noop),
      unlink(this.savePath).catch(noop),
    ])
  }
}