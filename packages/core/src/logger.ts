// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// Pluggable logger — bridges the legacy Logger interface with Pino
// =============================================================================

import { getAppLogger, redactSecrets } from './observability/logger'

export { redactSecrets }
import type pino from 'pino'

export interface Logger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  debug(msg: string, ...args: unknown[]): void
}

/**
 * Create a Logger adapter that delegates to a Pino child logger.
 * Structured context is passed as the first argument to each Pino call.
 */
function pinoAdapter(pinoLogger: pino.Logger): Logger {
  return {
    info: (msg, ...args) => {
      if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
        pinoLogger.info(args[0] as Record<string, unknown>, msg)
      } else {
        pinoLogger.info(msg)
      }
    },
    warn: (msg, ...args) => {
      if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
        pinoLogger.warn(args[0] as Record<string, unknown>, msg)
      } else {
        pinoLogger.warn(msg)
      }
    },
    error: (msg, ...args) => {
      if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
        pinoLogger.error(args[0] as Record<string, unknown>, msg)
      } else {
        pinoLogger.error(msg)
      }
    },
    debug: (msg, ...args) => {
      if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
        pinoLogger.debug(args[0] as Record<string, unknown>, msg)
      } else {
        pinoLogger.debug(msg)
      }
    },
  }
}

let currentLogger: Logger | null = null

export function getLogger(): Logger {
  if (!currentLogger) {
    currentLogger = pinoAdapter(getAppLogger())
  }
  return currentLogger
}

export function setLogger(logger: Logger): void {
  currentLogger = logger
}
