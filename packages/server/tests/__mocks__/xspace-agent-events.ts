// Stub mock for xspace-agent/dist/events sub-path
export class EventBuffer {
  push() {}
  flush() { return [] }
}
export class ConnectionManager {
  add() {}
  remove() {}
}
export type EventSubscriber = any
export type EventFilter = any
export type EventEnvelope = any
