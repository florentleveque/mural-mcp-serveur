import { MuralOAuth } from './oauth.js';
import { MuralRateLimiter } from './rate-limiter.js';
import type {
  CreateStickyNoteRequest,
  MuralBoard,
  MuralRoom,
  MuralTemplate,
  MuralUser,
  MuralWidget,
  MuralWorkspace,
  RateLimitConfig,
  ScopeCheckResult,
  UpdateStickyNoteRequest,
} from './types.js';

const MURAL_API_BASE = 'https://app.mural.co/api/public/v1';

/**
 * Typed error for non-ok Mural API responses.
 * Exposes the HTTP status and the machine-readable error code returned by
 * the API body ({ code, message } — see developers.mural.co/public/docs/error-codes)
 * so callers can branch on `status`/`errorCode` instead of message contents.
 */
export class MuralApiError extends Error {
  readonly nonRetryable: boolean;

  constructor(
    public readonly status: number,
    statusText: string,
    public readonly errorCode?: string,
    public readonly apiMessage?: string,
  ) {
    // Message format kept identical to the previous string-based errors
    // so existing callers and tests relying on it keep working.
    super(`Mural API request failed: HTTP ${status}: ${statusText}${apiMessage ? ` - ${apiMessage}` : ''}`);
    this.name = 'MuralApiError';
    // Client errors must never be retried by the catch-level retry logic.
    // 429 included: retryable 429s are handled upstream with `continue`, so a
    // thrown MuralApiError(429) only exists once retries are exhausted.
    this.nonRetryable = status >= 400 && status < 500;
  }
}

// Global authentication promise to prevent multiple concurrent auth flows
let globalAuthPromise: Promise<string> | null = null;

export class MuralClient {
  private oauth: MuralOAuth;
  private baseUrl: string;
  private rateLimiter: MuralRateLimiter;

  constructor(clientId: string, clientSecret?: string, redirectUri?: string, rateLimitConfig?: Partial<RateLimitConfig>) {
    this.oauth = new MuralOAuth(clientId, clientSecret, redirectUri);
    this.baseUrl = MURAL_API_BASE;
    this.rateLimiter = new MuralRateLimiter(rateLimitConfig);
  }

  private async getAccessToken(): Promise<string> {
    // If authentication is already in progress globally, wait for it
    if (globalAuthPromise) {
      return globalAuthPromise;
    }

    // Start new authentication and store globally
    globalAuthPromise = this.oauth.getValidAccessToken();

    try {
      const token = await globalAuthPromise;
      return token;
    } finally {
      // Clear the global promise when done (success or failure)
      globalAuthPromise = null;
    }
  }

  private async makeAuthenticatedRequest<T>(endpoint: string, options: RequestInit = {}, maxRetries: number = 3): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Check rate limits before making request
      const rateLimitCheck = await this.rateLimiter.canMakeRequest();
      if (!rateLimitCheck.allowed) {
        if (rateLimitCheck.waitTimeMs && rateLimitCheck.waitTimeMs <= 5000) {
          // If wait time is reasonable (≤5s), wait and retry
          console.warn(`Rate limit hit: ${rateLimitCheck.reason}. Waiting ${rateLimitCheck.waitTimeMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, rateLimitCheck.waitTimeMs));
          continue;
        } else {
          // If wait time is too long or not available, throw error
          throw new Error(`Rate limit exceeded: ${rateLimitCheck.reason}`);
        }
      }

      // Consume rate limit token
      const consumed = await this.rateLimiter.consumeRequest();
      if (!consumed) {
        throw new Error('Failed to consume rate limit token');
      }

      try {
        const accessToken = await this.getAccessToken();

        const url = `${this.baseUrl}${endpoint}`;
        const headers = {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...options.headers,
        };

        const response = await fetch(url, {
          ...options,
          headers,
        });

        // Handle rate limit responses from the API
        if (response.status === 429) {
          const waitTime = this.resolve429WaitMs(response.headers, attempt);

          if (attempt < maxRetries && waitTime <= 30000) {
            console.warn(`API rate limit hit (HTTP 429). Retrying after ${waitTime}ms... (attempt ${attempt + 1}/${maxRetries + 1})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          } else {
            throw new MuralApiError(429, 'Too Many Requests', undefined, 'API rate limit exceeded. Max retries reached or wait time too long.');
          }
        }

        if (!response.ok) {
          let errorCode: string | undefined;
          let apiMessage: string | undefined;

          try {
            const errorData = await response.json();
            if (typeof errorData.code === 'string') {
              errorCode = errorData.code;
            }
            if (errorData.message) {
              apiMessage = String(errorData.message);
            }
            if (errorData.errors && Array.isArray(errorData.errors)) {
              apiMessage = `${apiMessage ?? ''}${apiMessage ? ' - ' : ''}${errorData.errors.join(', ')}`;
            }
          } catch {
            // If error response isn't JSON, use status text only
          }

          // Retry on server errors (5xx) with exponential backoff; client
          // errors (4xx) are nonRetryable and rethrown by the catch below.
          if (attempt < maxRetries && response.status >= 500) {
            const backoffTime = Math.pow(2, attempt) * 1000;
            console.warn(`Server error (${response.status}). Retrying after ${backoffTime}ms... (attempt ${attempt + 1}/${maxRetries + 1})`);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
            continue;
          }

          throw new MuralApiError(response.status, response.statusText, errorCode, apiMessage);
        }

        // Some endpoints (e.g. DELETE) return 204 No Content / an empty body;
        // calling response.json() on those would throw, so handle empty bodies.
        if (response.status === 204) {
          return undefined as T;
        }
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      } catch (error) {
        // If it's our last attempt or a non-retryable error, throw.
        // The message checks guard OAuth errors coming from getAccessToken,
        // which are plain Errors rather than MuralApiError instances.
        if (
          attempt === maxRetries ||
          (error instanceof MuralApiError && error.nonRetryable) ||
          (error instanceof Error &&
            (error.message.includes('Rate limit exceeded') || error.message.includes('authentication') || error.message.includes('authorization')))
        ) {
          throw error;
        }

        // Otherwise, wait and retry with exponential backoff
        const backoffTime = Math.pow(2, attempt) * 1000;
        console.warn(`Request failed: ${error}. Retrying after ${backoffTime}ms... (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }

    throw new Error('Max retries exceeded');
  }

  /**
   * Compute how long to wait after a 429 response.
   * Mural does not send Retry-After; it sends x-ratelimit[-app]-reset (unix
   * epoch seconds) alongside x-ratelimit[-app]-remaining. Prefer the exact
   * reset of whichever bucket is exhausted, fall back to any reset header,
   * then to the standard Retry-After, and finally to exponential backoff.
   */
  private resolve429WaitMs(headers: Headers, attempt: number): number {
    const resetHeader =
      headers.get('x-ratelimit-remaining') === '0'
        ? headers.get('x-ratelimit-reset')
        : headers.get('x-ratelimit-app-remaining') === '0'
          ? headers.get('x-ratelimit-app-reset')
          : (headers.get('x-ratelimit-reset') ?? headers.get('x-ratelimit-app-reset'));

    if (resetHeader) {
      return Math.max(0, parseInt(resetHeader) * 1000 - Date.now());
    }

    const retryAfter = headers.get('Retry-After');
    return retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, attempt) * 1000;
  }

  async getWorkspaces(limit?: number, offset?: number): Promise<MuralWorkspace[]> {
    const params = new URLSearchParams();
    if (limit !== undefined) {
      params.append('limit', limit.toString());
    }
    if (offset !== undefined) {
      params.append('offset', offset.toString());
    }

    const queryString = params.toString();
    const endpoint = `/workspaces${queryString ? `?${queryString}` : ''}`;

    try {
      const response = await this.makeAuthenticatedRequest<any>(endpoint);
      // The API returns workspaces in a "value" property
      return response.value && Array.isArray(response.value) ? response.value : [];
    } catch (error) {
      console.error('Failed to fetch workspaces:', error);
      throw error;
    }
  }

  async getWorkspace(workspaceId: string): Promise<MuralWorkspace> {
    try {
      const workspace = await this.makeAuthenticatedRequest<MuralWorkspace>(`/workspaces/${workspaceId}`);
      return workspace;
    } catch (error) {
      console.error(`Failed to fetch workspace ${workspaceId}:`, error);
      throw error;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.getWorkspaces(1);
      return true;
    } catch (error) {
      console.error('Connection test failed:', error);
      return false;
    }
  }

  async clearAuthentication(): Promise<void> {
    // Clear the global auth promise
    globalAuthPromise = null;
    await this.oauth.clearTokens();
  }

  async getRateLimitStatus() {
    return await this.rateLimiter.getRateLimitStatus();
  }

  async resetRateLimits(): Promise<void> {
    await this.rateLimiter.reset();
  }

  /**
   * Fetch every page of a cursor-paginated endpoint and return a flat array.
   * The Mural API paginates list endpoints with `limit` + a `next` cursor.
   * Checks the OAuth scope once, then follows `next` until exhausted or the
   * safety cap (`maxPages`) is reached. Existing query params are preserved.
   */
  private async fetchAllPages<T>(basePath: string, scope: string, maxPages: number = 100): Promise<T[]> {
    const scopeCheck = await this.checkScope(scope);
    if (!scopeCheck.hasScope) {
      throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has '${scope}' scope and re-authenticate.`);
    }

    const items: T[] = [];
    const [path, existingQuery = ''] = basePath.split('?');
    let next: string | undefined;
    let page = 0;

    do {
      const params = new URLSearchParams(existingQuery);
      if (next) params.set('next', next);
      const queryString = params.toString();
      const endpoint = `${path}${queryString ? `?${queryString}` : ''}`;

      const response = await this.makeAuthenticatedRequest<any>(endpoint);
      const pageItems = response.value ?? response.widgets ?? response;
      if (Array.isArray(pageItems)) {
        items.push(...pageItems);
      }
      next = response.next;
      page++;
    } while (next && page < maxPages);

    if (next && page >= maxPages) {
      console.error(`fetchAllPages: reached the ${maxPages}-page cap for ${path}; results may be truncated.`);
    }

    return items;
  }

  async getWorkspaceRooms(workspaceId: string, openOnly: boolean = false): Promise<MuralRoom[]> {
    try {
      const endpoint = openOnly ? `/workspaces/${workspaceId}/rooms/open` : `/workspaces/${workspaceId}/rooms`;
      return await this.fetchAllPages<MuralRoom>(endpoint, 'rooms:read');
    } catch (error) {
      if (error instanceof MuralApiError && (error.status === 403 || error.errorCode === 'INVALID_SCOPE')) {
        const scopeCheck = await this.checkScope('rooms:read');
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'rooms:read' scope and re-authenticate.`);
      }
      console.error(`Failed to fetch rooms for workspace ${workspaceId}:`, error);
      throw error;
    }
  }

  async getWorkspaceTemplates(workspaceId: string, searchQuery?: string, withoutDefault: boolean = false): Promise<MuralTemplate[]> {
    try {
      let endpoint: string;
      if (searchQuery && searchQuery.trim()) {
        endpoint = `/search/${workspaceId}/templates?q=${encodeURIComponent(searchQuery.trim())}`;
      } else {
        endpoint = `/workspaces/${workspaceId}/templates`;
        if (withoutDefault) {
          endpoint += '?withoutDefault=true';
        }
      }
      return await this.fetchAllPages<MuralTemplate>(endpoint, 'templates:read');
    } catch (error) {
      if (error instanceof MuralApiError && (error.status === 403 || error.errorCode === 'INVALID_SCOPE')) {
        const scopeCheck = await this.checkScope('templates:read');
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'templates:read' scope and re-authenticate.`);
      }
      console.error(`Failed to fetch templates for workspace ${workspaceId}:`, error);
      throw error;
    }
  }

  async createMuralFromTemplate(templateId: string, title: string, roomId: number, folderId?: string): Promise<MuralBoard> {
    try {
      const scopeCheck = await this.checkScope('murals:write');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:write' scope and re-authenticate.`);
      }

      const body: Record<string, unknown> = { title, roomId };
      if (folderId) {
        body.folderId = folderId;
      }

      const response = await this.makeAuthenticatedRequest<any>(`/templates/${encodeURIComponent(templateId)}/murals`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return response.value || response;
    } catch (error) {
      console.error(`Failed to create mural from template ${templateId}:`, error);
      throw error;
    }
  }

  async createRoom(workspaceId: string, name: string, type: 'open' | 'private', description?: string, confidential?: boolean): Promise<MuralRoom> {
    try {
      const scopeCheck = await this.checkScope('rooms:write');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'rooms:write' scope and re-authenticate.`);
      }

      const body: Record<string, unknown> = { name, type, workspaceId };
      if (description !== undefined) {
        body.description = description;
      }
      if (confidential !== undefined) {
        body.confidential = confidential;
      }

      const response = await this.makeAuthenticatedRequest<any>('/rooms', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return response.value || response;
    } catch (error) {
      console.error(`Failed to create room "${name}" in workspace ${workspaceId}:`, error);
      throw error;
    }
  }

  async createMural(
    roomId: number,
    options: { title?: string; backgroundColor?: string; width?: number; height?: number; infinite?: boolean; folderId?: string } = {},
  ): Promise<MuralBoard> {
    try {
      const scopeCheck = await this.checkScope('murals:write');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:write' scope and re-authenticate.`);
      }
      const body: Record<string, unknown> = { roomId, ...options };
      const response = await this.makeAuthenticatedRequest<any>('/murals', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return response.value || response;
    } catch (error) {
      console.error(`Failed to create mural in room ${roomId}:`, error);
      throw error;
    }
  }

  async updateMural(muralId: string, updates: Record<string, unknown>): Promise<MuralBoard> {
    try {
      const scopeCheck = await this.checkScope('murals:write');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:write' scope and re-authenticate.`);
      }
      const response = await this.makeAuthenticatedRequest<any>(`/murals/${encodeURIComponent(muralId)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
      return response.value || response;
    } catch (error) {
      console.error(`Failed to update mural ${muralId}:`, error);
      throw error;
    }
  }

  async deleteMural(muralId: string): Promise<void> {
    try {
      const scopeCheck = await this.checkScope('murals:write');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:write' scope and re-authenticate.`);
      }
      await this.makeAuthenticatedRequest<void>(`/murals/${encodeURIComponent(muralId)}`, { method: 'DELETE' });
    } catch (error) {
      console.error(`Failed to delete mural ${muralId}:`, error);
      throw error;
    }
  }

  async duplicateMural(muralId: string, roomId: number, title: string, options: { folderId?: string; infinite?: boolean } = {}): Promise<MuralBoard> {
    try {
      const scopeCheck = await this.checkScope('murals:write');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:write' scope and re-authenticate.`);
      }
      const body: Record<string, unknown> = { roomId, title, ...options };
      const response = await this.makeAuthenticatedRequest<any>(`/murals/${encodeURIComponent(muralId)}/duplicate`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return response.value || response;
    } catch (error) {
      console.error(`Failed to duplicate mural ${muralId}:`, error);
      throw error;
    }
  }

  async exportMural(muralId: string, downloadFormat: string): Promise<any> {
    try {
      const scopeCheck = await this.checkScope('murals:read');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:read' scope and re-authenticate.`);
      }
      const response = await this.makeAuthenticatedRequest<any>(`/murals/${encodeURIComponent(muralId)}/export`, {
        method: 'POST',
        body: JSON.stringify({ downloadFormat }),
      });
      return response.value || response;
    } catch (error) {
      console.error(`Failed to export mural ${muralId}:`, error);
      throw error;
    }
  }

  async getWorkspaceMurals(workspaceId: string): Promise<MuralBoard[]> {
    try {
      // Check if user has required scope first
      const scopeCheck = await this.checkScope('murals:read');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:read' scope and re-authenticate.`);
      }

      // Try RESTful endpoint (legacy endpoints appear to be deprecated/non-existent)
      const response = await this.makeAuthenticatedRequest<any>(`/workspaces/${workspaceId}/murals`);

      // The API response structure may vary, handle both direct array and wrapped response
      const murals = response.value || response.murals || response;
      return Array.isArray(murals) ? murals : [];
    } catch (error) {
      // Check if error is scope-related and provide helpful message
      if (error instanceof MuralApiError) {
        if (error.status === 403 || error.errorCode === 'INVALID_SCOPE') {
          const scopeCheck = await this.checkScope('murals:read');
          throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:read' scope and re-authenticate.`);
        }
      }
      console.error(`Failed to fetch murals for workspace ${workspaceId}:`, error);
      throw error;
    }
  }

  async getRoomMurals(roomId: string): Promise<MuralBoard[]> {
    try {
      // Check if user has required scope first
      const scopeCheck = await this.checkScope('murals:read');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:read' scope and re-authenticate.`);
      }

      // Try RESTful endpoint (legacy endpoints appear to be deprecated/non-existent)
      const response = await this.makeAuthenticatedRequest<any>(`/rooms/${roomId}/murals`);

      // The API response structure may vary, handle both direct array and wrapped response
      const murals = response.value || response.murals || response;
      return Array.isArray(murals) ? murals : [];
    } catch (error) {
      // Check if error is scope-related and provide helpful message
      if (error instanceof MuralApiError) {
        if (error.status === 403 || error.errorCode === 'INVALID_SCOPE') {
          const scopeCheck = await this.checkScope('murals:read');
          throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:read' scope and re-authenticate.`);
        }
      }
      console.error(`Failed to fetch murals for room ${roomId}:`, error);
      throw error;
    }
  }

  async getMural(muralId: string): Promise<MuralBoard> {
    try {
      // Check if user has required scope first
      const scopeCheck = await this.checkScope('murals:read');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:read' scope and re-authenticate.`);
      }

      const mural = await this.makeAuthenticatedRequest<MuralBoard>(`/murals/${muralId}`);
      return mural;
    } catch (error) {
      // Check if error is scope-related and provide helpful message
      if (error instanceof MuralApiError) {
        if (error.status === 403 || error.errorCode === 'INVALID_SCOPE') {
          const scopeCheck = await this.checkScope('murals:read');
          throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:read' scope and re-authenticate.`);
        }
      }
      console.error(`Failed to fetch mural ${muralId}:`, error);
      throw error;
    }
  }

  async getCurrentUser(): Promise<MuralUser> {
    try {
      const user = await this.makeAuthenticatedRequest<MuralUser>(`/users/me`);
      return user;
    } catch (error) {
      console.error('Failed to fetch current user:', error);
      throw error;
    }
  }

  async getUserScopes(): Promise<string[]> {
    try {
      // Extract scopes from the stored OAuth token (primary method)
      const tokens = await this.oauth.getStoredTokens();
      if (!tokens) {
        return [];
      }

      // First check if scopes are in the top-level scope field
      if (tokens.scope) {
        return tokens.scope.split(' ').filter(scope => scope.trim() !== '');
      }

      // If no top-level scope field, try to decode JWT access token
      if (tokens.access_token) {
        try {
          // Decode JWT payload (without verification - just for scope extraction)
          const payloadPart = tokens.access_token.split('.')[1];
          if (payloadPart) {
            const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
            if (payload.scopes && Array.isArray(payload.scopes)) {
              return payload.scopes;
            }
          }
        } catch (jwtError) {
          console.warn('Failed to decode JWT for scope extraction:', jwtError);
        }
      }

      // If no stored tokens or scope information, return empty array
      // Don't try to fetch from API as that might require scopes we don't have
      return [];
    } catch (error) {
      console.error('Failed to get user scopes:', error);
      return [];
    }
  }

  async checkScope(requiredScope: string): Promise<ScopeCheckResult> {
    try {
      const availableScopes = await this.getUserScopes();
      const hasScope = availableScopes.includes(requiredScope);

      return {
        hasScope,
        requiredScope,
        availableScopes,
        message: hasScope
          ? `User has required scope: ${requiredScope}`
          : `User missing required scope: ${requiredScope}. Available scopes: ${availableScopes.join(', ') || 'none'}`,
      };
    } catch (error) {
      return {
        hasScope: false,
        requiredScope,
        availableScopes: [],
        message: `Failed to check scopes: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  async debugWorkspacesAPI(): Promise<any> {
    const accessToken = await this.oauth.getValidAccessToken();

    const url = `${this.baseUrl}/workspaces`;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    try {
      const response = await fetch(url, { headers });

      const debugInfo = {
        url,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        timestamp: new Date().toISOString(),
      };

      let responseData;
      try {
        responseData = await response.json();
      } catch (e) {
        responseData = await response.text();
      }

      return {
        request: debugInfo,
        response: {
          value: responseData,
          raw: responseData,
        },
        success: response.ok,
      };
    } catch (error) {
      return {
        request: { url, headers: { ...headers, Authorization: '[REDACTED]' } },
        error: error instanceof Error ? error.message : 'Unknown error',
        success: false,
      };
    }
  }

  // ============================================================================
  // CONTENT API METHODS
  // ============================================================================

  // Widget operations
  async getMuralWidgets(muralId: string): Promise<MuralWidget[]> {
    try {
      // Paginated: follows the API's `next` cursor so all widgets are returned
      // (the endpoint pages at ~100 widgets).
      return await this.fetchAllPages<MuralWidget>(`/murals/${encodeURIComponent(muralId)}/widgets`, 'murals:read');
    } catch (error) {
      if (error instanceof MuralApiError && (error.status === 403 || error.errorCode === 'INVALID_SCOPE')) {
        const scopeCheck = await this.checkScope('murals:read');
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:read' scope and re-authenticate.`);
      }
      console.error(`Failed to fetch widgets for mural ${muralId}:`, error);
      throw error;
    }
  }

  async getMuralWidget(muralId: string, widgetId: string): Promise<MuralWidget> {
    try {
      const scopeCheck = await this.checkScope('murals:read');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:read' scope and re-authenticate.`);
      }

      const response = await this.makeAuthenticatedRequest<MuralWidget>(`/murals/${encodeURIComponent(muralId)}/widgets/${encodeURIComponent(widgetId)}`);
      return response;
    } catch (error) {
      console.error(`Failed to fetch widget ${widgetId} from mural ${muralId}:`, error);
      throw error;
    }
  }

  async deleteWidget(muralId: string, widgetId: string): Promise<void> {
    try {
      const scopeCheck = await this.checkScope('murals:write');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:write' scope and re-authenticate.`);
      }

      await this.makeAuthenticatedRequest<void>(`/murals/${encodeURIComponent(muralId)}/widgets/${encodeURIComponent(widgetId)}`, {
        method: 'DELETE',
      });
    } catch (error) {
      console.error(`Failed to delete widget ${widgetId} from mural ${muralId}:`, error);
      throw error;
    }
  }

  // Widget creation methods
  async createStickyNotes(muralId: string, stickyNotes: CreateStickyNoteRequest[]): Promise<MuralWidget[]> {
    try {
      const scopeCheck = await this.checkScope('murals:write');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:write' scope and re-authenticate.`);
      }

      if (stickyNotes.length > 1000) {
        throw new Error('Maximum 1000 sticky notes per request');
      }

      const response = await this.makeAuthenticatedRequest<any>(`/murals/${encodeURIComponent(muralId)}/widgets/sticky-note`, {
        method: 'POST',
        body: JSON.stringify(stickyNotes),
      });

      return response.value || response || [];
    } catch (error) {
      console.error(`Failed to create sticky notes for mural ${muralId}:`, error);
      throw error;
    }
  }
  // ============================================================================
  // WIDGET UPDATE METHODS (PATCH OPERATIONS)
  // ============================================================================

  async updateStickyNote(muralId: string, widgetId: string, updates: UpdateStickyNoteRequest): Promise<MuralWidget> {
    try {
      const scopeCheck = await this.checkScope('murals:write');
      if (!scopeCheck.hasScope) {
        throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:write' scope and re-authenticate.`);
      }

      const response = await this.makeAuthenticatedRequest<any>(`/murals/${encodeURIComponent(muralId)}/widgets/sticky-note/${encodeURIComponent(widgetId)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
      return response.value || response;
    } catch (error) {
      console.error(`Failed to update sticky note ${widgetId} in mural ${muralId}:`, error);
      throw error;
    }
  }

  // ============================================================================
  // GENERIC WIDGET CREATION / UPDATE (used by shape, arrow, text-box, title, area)
  // ============================================================================

  private async createWidgetsOfKind(
    muralId: string,
    kind: 'shape' | 'arrow' | 'text-box' | 'title' | 'area',
    widgets: Record<string, unknown>[],
  ): Promise<MuralWidget[]> {
    const scopeCheck = await this.checkScope('murals:write');
    if (!scopeCheck.hasScope) {
      throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:write' scope and re-authenticate.`);
    }

    const response = await this.makeAuthenticatedRequest<any>(`/murals/${encodeURIComponent(muralId)}/widgets/${kind}`, {
      method: 'POST',
      body: JSON.stringify(widgets),
    });
    return response.value || response || [];
  }

  private async updateWidgetOfKind(
    muralId: string,
    kind: 'shape' | 'arrow' | 'text-box' | 'title' | 'area' | 'sticky-note',
    widgetId: string,
    updates: Record<string, unknown>,
  ): Promise<MuralWidget> {
    const scopeCheck = await this.checkScope('murals:write');
    if (!scopeCheck.hasScope) {
      throw new Error(`Permission denied: ${scopeCheck.message}. Please ensure your Mural OAuth app has 'murals:write' scope and re-authenticate.`);
    }

    const response = await this.makeAuthenticatedRequest<any>(`/murals/${encodeURIComponent(muralId)}/widgets/${kind}/${encodeURIComponent(widgetId)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    return response.value || response;
  }

  async createShapes(muralId: string, shapes: Record<string, unknown>[]): Promise<MuralWidget[]> {
    return this.createWidgetsOfKind(muralId, 'shape', shapes);
  }

  async createArrows(muralId: string, arrows: Record<string, unknown>[]): Promise<MuralWidget[]> {
    return this.createWidgetsOfKind(muralId, 'arrow', arrows);
  }

  async createTextBoxes(muralId: string, textBoxes: Record<string, unknown>[]): Promise<MuralWidget[]> {
    return this.createWidgetsOfKind(muralId, 'text-box', textBoxes);
  }

  async createTitles(muralId: string, titles: Record<string, unknown>[]): Promise<MuralWidget[]> {
    return this.createWidgetsOfKind(muralId, 'title', titles);
  }

  async createAreas(muralId: string, areas: Record<string, unknown>[]): Promise<MuralWidget[]> {
    return this.createWidgetsOfKind(muralId, 'area', areas);
  }

  async updateShape(muralId: string, widgetId: string, updates: Record<string, unknown>): Promise<MuralWidget> {
    return this.updateWidgetOfKind(muralId, 'shape', widgetId, updates);
  }

  async updateArrow(muralId: string, widgetId: string, updates: Record<string, unknown>): Promise<MuralWidget> {
    return this.updateWidgetOfKind(muralId, 'arrow', widgetId, updates);
  }

  async updateTextBox(muralId: string, widgetId: string, updates: Record<string, unknown>): Promise<MuralWidget> {
    return this.updateWidgetOfKind(muralId, 'text-box', widgetId, updates);
  }

  async updateTitle(muralId: string, widgetId: string, updates: Record<string, unknown>): Promise<MuralWidget> {
    return this.updateWidgetOfKind(muralId, 'title', widgetId, updates);
  }

  async updateArea(muralId: string, widgetId: string, updates: Record<string, unknown>): Promise<MuralWidget> {
    return this.updateWidgetOfKind(muralId, 'area', widgetId, updates);
  }
}
