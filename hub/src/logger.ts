import pino, { type DestinationStream, type Logger, type Level } from 'pino'

// The hub's log, a JSON line each. What goes in it may be read by anyone who can read the server's logs, so a request is
// its method and path alone (GitHub's sign-in sends its code in the query string), and whatever looks like a credential
// is held back wherever a line happens to carry it. Tokens stay sealed in Redis and memory: logging one is a bug, and
// this is the net under that.

const held = ['token', 'clientSecret', 'client_secret', 'secret', 'password', 'authorization', 'cookie']
const redact = {
  paths: [...held, ...held.map((key) => `*.${key}`), 'headers.authorization', 'headers.cookie', 'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  censor: '[held back]',
}

export function makeLogger(destination?: DestinationStream, level: Level | 'silent' = 'info'): Logger {
  return pino({
    level,
    redact,
    serializers: {
      req: (request: { method?: string; url?: string; id?: string }) => ({ id: request.id, method: request.method, path: request.url?.split('?')[0] }),
      res: (reply: { statusCode?: number }) => ({ status: reply.statusCode }),
      err: pino.stdSerializers.err,
    },
  }, destination)
}

/** The hub's own: LOG_LEVEL sets how much (the tests turn it off). */
export const log = makeLogger(undefined, (process.env.LOG_LEVEL as Level | 'silent' | undefined) ?? 'info')
