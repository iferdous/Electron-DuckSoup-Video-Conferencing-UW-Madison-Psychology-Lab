import path from 'node:path'

export const join = path.join

export const sanitize = (value: string): string =>
  value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim()

