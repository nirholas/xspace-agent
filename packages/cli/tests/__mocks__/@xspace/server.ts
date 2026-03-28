// Stub module for @xspace/server so vitest can resolve the import.
// Tests override this with vi.mock().
export function createServer(_opts: any) {
  return {
    start: async () => {},
    stop: async () => {},
  }
}
