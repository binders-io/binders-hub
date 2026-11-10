// How the runner gets out of a managed network: the certificates the machine trusts, and its proxy. Node uses neither
// on its own, and a background service doesn't get the settings a person's shell has.

/** What a service is given from the shell that sets it up: its proxy and certificate settings, for the runner and its agents. */
const carried = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HF_HOME', 'HF_HUB_CACHE']

export function serviceEnv(env: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(carried.flatMap((name) => (env[name] ? [[name, env[name]!]] : []))) as Record<string, string>
}

const hasProxy = (env: NodeJS.ProcessEnv) => ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((name) => env[name])

/** Marks a NODE_USE_ENV_PROXY the runner added for itself, to keep it from the agents it starts. */
const addedProxy = 'BINDERS_ADDED_ENV_PROXY'

/**
 * What a Node process that talks to the hub starts with: the system's certificates, where this Node can read them, and
 * its proxy, which fetch ignores unless told. Both are read as Node starts, and a flag doesn't reach a process it
 * spawns, so they're given to each process that needs them.
 */
export function nodeNetwork(env: NodeJS.ProcessEnv = process.env, flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags) {
  return {
    args: flags.has('--use-system-ca') ? ['--use-system-ca'] : [],
    env: hasProxy(env) && env.NODE_USE_ENV_PROXY === undefined ? { NODE_USE_ENV_PROXY: '1', [addedProxy]: '1' } : {},
  }
}

/** The process that does the work, as the supervisor starts it. */
export function workerCommand(file: string, argv: string[], env: NodeJS.ProcessEnv = process.env, flags?: ReadonlySet<string>) {
  const network = nodeNetwork(env, flags)
  return { args: [...network.args, file, ...argv], env: { ...env, ...network.env } }
}

/** Keeps what the runner added for itself out of what its agents inherit: their own tests shouldn't start using a proxy. Node has read it by now. */
export function settleNetwork(env: NodeJS.ProcessEnv = process.env) {
  if (!env[addedProxy]) return
  delete env.NODE_USE_ENV_PROXY
  delete env[addedProxy]
}

const certificateCodes = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'])
const unreachedCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])

interface Failure { message?: string; code?: string; cause?: unknown; errors?: unknown[] }

/** The failure under an error: fetch says only "fetch failed", and keeps why in its cause (several, for a name with many addresses). */
function underlying(error: unknown) {
  let found: Failure | undefined
  let at = error as Failure | undefined
  for (let depth = 0; at && depth < 6; depth++) {
    if (depth && (at.code || at.message)) found = at
    at = (at.cause ?? at.errors?.[0]) as Failure | undefined
  }
  return found
}

/** Node's ability to follow a proxy setting, which came in 24.0, and in 22.21 before it. */
function followsProxy(version: string) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number)
  return major >= 24 || (major === 22 && minor >= 21)
}

/** What to tell a person about a failure to reach somewhere: the cause, and what to try when the cause is a known one. */
export function reasonOf(error: unknown, env: NodeJS.ProcessEnv = process.env, version = process.version, flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags) {
  const top = (error as Failure | undefined)?.message ?? String(error)
  const cause = underlying(error)
  if (!cause) return top
  const code = cause.code
  const detail = cause.message && cause.message !== code && !top.includes(cause.message) ? cause.message : ''
  const said = `${top} (${[code, detail].filter(Boolean).join(': ')})`
  if (code && certificateCodes.has(code)) {
    const store = flags.has('--use-system-ca') ? 'If your network signs HTTPS itself, its certificate belongs in this machine’s certificate store, which the runner reads, or point NODE_EXTRA_CA_CERTS at it.' : `Node ${version} can’t read this machine’s certificate store: update Node, or point NODE_EXTRA_CA_CERTS at your network’s certificate.`
    return `${said}. This machine doesn’t trust the certificate it was shown. ${store}`
  }
  if (hasProxy(env) && !followsProxy(version)) return `${said}. A proxy is set, but Node ${version} can’t use one: update to Node 24 or newer.`
  if (code && unreachedCodes.has(code) && !hasProxy(env)) return `${said}. If this network needs a proxy, set HTTPS_PROXY and run binders add again.`
  return said
}
