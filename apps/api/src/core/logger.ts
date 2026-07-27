type LogLevel = 'info' | 'warn' | 'error'

const write = (level: LogLevel, message: string, data?: unknown) => {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`

  if (data === undefined) {
    console[level](line)
    return
  }

  console[level](line, data)
}

export const logger = {
  info: (message: string, data?: unknown) => write('info', message, data),
  warn: (message: string, data?: unknown) => write('warn', message, data),
  error: (message: string, data?: unknown) => write('error', message, data),
}
