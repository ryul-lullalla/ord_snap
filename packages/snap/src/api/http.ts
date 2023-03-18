export class AgentError extends Error {
  constructor(public readonly message: string) {
    super(message);
    Object.setPrototypeOf(this, AgentError.prototype);
  }
}

export class HttpDefaultFetchError extends AgentError {
  constructor(public readonly message: string) {
    super(message);
  }
}

export interface HttpPostRequest extends Record<string, any> {}

export type HttpRequest = HttpPostRequest;

export interface HttpAgentRequestTransformFn {
  (args: HttpRequest): Promise<HttpRequest | undefined | void>;
  priority?: number;
}

// IC0 domain info
const API_DOMAIN = 'astrox.app';
const API_SUB_DOMAIN = '.astrox.app';

export interface HttpAgentOptions {
  // A surrogate to the global fetch function. Useful for testing.
  fetch?: typeof fetch;

  // Additional options to pass along to fetch. Will not override fields that
  // the agent already needs to set
  // Should follow the RequestInit interface, but we intentially support non-standard fields
  fetchOptions?: Record<string, unknown>;

  // Additional options to pass along to fetch for the call API.
  callOptions?: Record<string, unknown>;

  // The host to use for the client. By default, uses the same host as
  // the current page.
  host?: string;

  credentials?: {
    name: string;
    password?: string;
  };
  /**
   * Prevents the agent from providing a unique {@link Nonce} with each call.
   * Enabling may cause rate limiting of identical requests
   * at the boundary nodes.
   *
   * To add your own nonce generation logic, you can use the following:
   * @example
   * import {makeNonceTransform, makeNonce} from '@dfinity/agent';
   * const agent = new HttpAgent({ disableNonce: true });
   * agent.addTransform(makeNonceTransform(makeNonce);
   * @default false
   */
  disableNonce?: boolean;
  /**
   * Number of times to retry requests before throwing an error
   * @default 3
   */
  retryTimes?: number;
}

export function getDefaultFetch(): typeof fetch {
  let defaultFetch;

  if (typeof window !== 'undefined') {
    // Browser context
    if (window.fetch) {
      defaultFetch = window.fetch.bind(window);
    } else {
      throw new HttpDefaultFetchError(
        'Fetch implementation was not available. You appear to be in a browser context, but window.fetch was not present.',
      );
    }
  } else if (typeof global !== 'undefined') {
    // Node context
    if (global.fetch) {
      defaultFetch = global.fetch.bind(global);
    } else {
      throw new HttpDefaultFetchError(
        'Fetch implementation was not available. You appear to be in a Node.js context, but global.fetch was not available.',
      );
    }
  } else if (typeof self !== 'undefined') {
    if (self.fetch) {
      defaultFetch = self.fetch.bind(self);
    }
  }

  if (defaultFetch) {
    return defaultFetch;
  }
  throw new HttpDefaultFetchError(
    'Fetch implementation was not available. Please provide fetch to the HttpAgent constructor, or ensure it is available in the window or global context.',
  );
}

export class HttpClient {
  private readonly _pipeline: HttpAgentRequestTransformFn[] = [];
  private readonly _fetch: typeof fetch;
  private readonly _fetchOptions?: Record<string, unknown>;
  private readonly _callOptions?: Record<string, unknown>;
  private _timeDiffMsecs = 0;
  private readonly _host: URL;
  private readonly _credentials: string | undefined;
  private _rootKeyFetched = false;
  private _retryTimes = 3; // Retry requests 3 times before erroring by default
  constructor(options: HttpAgentOptions = {}) {
    this._fetch = options.fetch || getDefaultFetch() || fetch.bind(global);
    this._fetchOptions = options.fetchOptions;
    this._callOptions = options.callOptions;
    if (options.host !== undefined) {
      if (!options.host.match(/^[a-z]+:/) && typeof window !== 'undefined') {
        this._host = new URL(window.location.protocol + '//' + options.host);
      } else {
        this._host = new URL(options.host);
      }
    } else {
      const location = typeof window !== 'undefined' ? window.location : undefined;
      if (!location) {
        throw new Error('Must specify a host to connect to.');
      }
      this._host = new URL(location + '');
    }
    // Default is 3, only set if option is provided
    if (options.retryTimes !== undefined) {
      this._retryTimes = options.retryTimes;
    }
    // Rewrite to avoid redirects
    if (this._host.hostname.endsWith(API_SUB_DOMAIN)) {
      this._host.hostname = API_DOMAIN;
    }

    if (options.credentials) {
      const { name, password } = options.credentials;
      this._credentials = `${name}${password ? ':' + password : ''}`;
    }
  }

  public isLocal(): boolean {
    const hostname = this._host.hostname;
    return hostname === '127.0.0.1' || hostname.endsWith('localhost');
  }

  public addTransform(fn: HttpAgentRequestTransformFn, priority = fn.priority || 0): void {
    // Keep the pipeline sorted at all time, by priority.
    const i = this._pipeline.findIndex(x => (x.priority || 0) < priority);
    this._pipeline.splice(i >= 0 ? i : this._pipeline.length, 0, Object.assign(fn, { priority }));
  }

  public async httpGet(endpoint: string, body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = this._credentials
      ? {
          Authorization: 'Basic ' + Buffer.from(this._credentials, 'base64'),
        }
      : {};

    let url = endpoint;
    let c = 0;
    for (const id in body) {
      if (c == 0) {
        url += '?';
      } else {
        url += '&';
      }
      url += `${id}=${body[id]}`;
      c++;
    }

    const response = await this._requestAndRetry(() => this._fetch('' + new URL(`${url}`, this._host), { headers, ...this._fetchOptions }));
    return response;
  }
  public async httpPost(endpoint: string, body: Record<string, unknown>): Promise<Response> {
    const payload = {
      request: {
        method: 'POST',
        headers: new Headers({
          'Content-Type': 'application/json',
          ...(this._credentials ? { Authorization: 'Basic ' + Buffer.from(this._credentials, 'base64') } : {}),
        }),
      },
      endpoint,
      body,
    };
    const transformed = await this._transform(payload);

    const response = await this._requestAndRetry(() =>
      this._fetch('' + new URL(`${endpoint}`, this._host), {
        ...this._callOptions,
        ...payload.request,
        body: transformed.body,
      }),
    );
    return response;
  }

  private async _requestAndRetry(request: () => Promise<Response>, tries = 0): Promise<Response> {
    if (tries > this._retryTimes && this._retryTimes !== 0) {
      throw new Error(
        `AgentError: Exceeded configured limit of ${this._retryTimes} retry attempts. Please check your network connection or try again in a few moments`,
      );
    }
    const response = await request();
    if (!response.ok) {
      const responseText = await response.clone().text();
      const errorMessage = `Server returned an error:\n` + `  Code: ${response.status} (${response.statusText})\n` + `  Body: ${responseText}\n`;
      if (this._retryTimes > tries) {
        console.warn(errorMessage + `  Retrying request.`);
        return await this._requestAndRetry(request, tries + 1);
      } else {
        throw new Error(errorMessage);
      }
    }

    return response;
  }

  protected _transform(request: HttpRequest): Promise<HttpRequest> {
    let p = Promise.resolve(request);

    for (const fn of this._pipeline) {
      p = p.then(r => fn(r).then(r2 => r2 || r));
    }

    return p;
  }
}