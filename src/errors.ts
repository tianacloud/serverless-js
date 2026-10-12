export class TianaFetchProtocolError extends Error {
  readonly code = "TIANA_FETCH_PROTOCOL_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "TianaFetchProtocolError";
  }
}

export function protocolError(message: string): TianaFetchProtocolError {
  return new TianaFetchProtocolError(message);
}
