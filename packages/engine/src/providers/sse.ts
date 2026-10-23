export interface SSEMessage {
  event?: string;
  data: string;
}

/**
 * Minimal SSE reader that tolerates partial TCP frames, CRLF, comments and
 * keep-alive lines. Yields one message per blank-line delimiter.
 */
export async function* readSSE(response: Response): AsyncGenerator<SSEMessage> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let dataLines: string[] = [];

  const flush = function* (): Generator<SSEMessage> {
    if (dataLines.length > 0) {
      yield { event, data: dataLines.join('\n') };
    }
    event = undefined;
    dataLines = [];
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        yield* flush();
      } else if (line.startsWith(':')) {
        // comment / keep-alive
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      newline = buffer.indexOf('\n');
    }
  }

  yield* flush();
}
