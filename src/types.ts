// ============================================================================
// MURAL API TYPES
//
// These interfaces mirror the real Mural public API v1 responses (captured
// against app.mural.co on 2026-06-08), not a hand-written subset. The API may
// return additional fields; the ones declared here are the observed ones.
// The client returns these shapes verbatim; the LLM-facing trimming happens in
// projections.ts.
// ============================================================================

/** Minimal user reference embedded in many entities (createdBy/updatedBy/...). */
export interface MuralUserRef {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  alias?: string;
  type?: string;
}

export interface MuralWorkspace {
  id: string;
  name: string;
  description?: string;
  image?: string;
  locked?: boolean;
  suspended?: boolean;
  createdOn?: number;
  sharingSettings?: Record<string, unknown>;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  expires_at?: number;
}

export interface OAuthError {
  error: string;
  error_description?: string;
}

export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

export interface AuthorizationParams {
  client_id: string;
  redirect_uri: string;
  scope: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string;
}

export interface TokenExchangeParams {
  client_id: string;
  client_secret?: string;
  code: string;
  code_verifier: string;
  grant_type: string;
  redirect_uri: string;
}

export interface RefreshTokenParams {
  client_id: string;
  client_secret?: string;
  refresh_token: string;
  grant_type: string;
}

export interface RateLimitBucket {
  capacity: number;
  tokens: number;
  refillRate: number;
  lastRefill: number;
  refillIntervalMs: number;
}

export interface RateLimitState {
  userBucket: RateLimitBucket;
  appBucket: RateLimitBucket;
  lastUpdated: number;
}

export interface RateLimitConfig {
  userRequestsPerSecond: number;
  appRequestsPerMinute: number;
  persistState: boolean;
}

export interface RateLimitStatus {
  user: {
    tokensRemaining: number;
    capacity: number;
    refillRate: number;
    nextRefillIn: number;
  };
  app: {
    tokensRemaining: number;
    capacity: number;
    refillRate: number;
    nextRefillIn: number;
  };
  lastUpdated: number;
}

export interface MuralBoard {
  id: string;
  title: string;
  status?: string;
  roomId?: number | string;
  workspaceId?: string;
  favorite?: boolean;
  infinite?: boolean;
  state?: string;
  createdOn?: number;
  updatedOn?: number;
  createdBy?: MuralUserRef;
  updatedBy?: MuralUserRef;
  thumbnailUrl?: string;
  _canvasLink?: string;
  sharingSettings?: { link?: string } & Record<string, unknown>;
  visitorsSettings?: { link?: string; visitors?: string; workspaceMembers?: string } & Record<string, unknown>;
}

// Status payload of an async mural export job (GET /murals/{id}/exports/{exportId}).
// `url` is present only once the export is ready; the exact pending shape is undocumented.
export interface MuralExportStatus {
  url?: string;
  [key: string]: unknown;
}

export interface MuralRoom {
  id: number | string;
  name?: string;
  type?: string;
  confidential?: boolean;
  favorite?: boolean;
  description?: string;
  isMember?: boolean;
  workspaceId?: string;
  createdOn?: number | string;
  updatedOn?: number | string;
  createdBy?: MuralUserRef;
  updatedBy?: MuralUserRef;
}

export interface MuralTemplate {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  workspaceId?: string;
  // For default templates the API returns the string "MURAL"; custom templates
  // may return a user reference instead — hence the union.
  createdBy?: string | MuralUserRef;
  updatedBy?: string | MuralUserRef;
  createdOn?: number | string;
  updatedOn?: number | string;
  thumbUrl?: string;
  viewLink?: string;
}

export interface MuralUser {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  type?: string;
  scopes?: string[];
}

export interface ScopeCheckResult {
  hasScope: boolean;
  requiredScope: string;
  availableScopes: string[];
  message: string;
}

// ============================================================================
// MURAL CONTENTS API TYPES
// ============================================================================

/**
 * Loose style object returned on widgets. The actual keys depend on the widget
 * kind (sticky note, shape, arrow...). Common observed keys are declared; the
 * index signature keeps unknown kind-specific keys without losing type safety.
 */
export interface WidgetStyle {
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderStyle?: string;
  font?: string;
  fontSize?: number;
  fontColor?: string;
  textColor?: string;
  textAlign?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  border?: boolean;
  [key: string]: unknown;
}

/** Style accepted when creating/updating sticky notes (request side). */
export interface WidgetTextStyle {
  backgroundColor?: string;
  textColor?: string;
  fontSize?: number;
  fontFamily?: string;
  alignment?: 'left' | 'center' | 'right';
}

/** Fields common to every widget returned by the API (response side). */
export interface MuralWidgetBase {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  parentId?: string | null;
  title?: string;
  style?: WidgetStyle;
  // Layout / facilitation metadata (rarely needed by callers).
  stackingOrder?: number;
  presentationIndex?: number;
  minLines?: number;
  instruction?: string;
  hidden?: boolean;
  hideEditor?: boolean;
  hideOwner?: boolean;
  invisible?: boolean;
  locked?: boolean;
  lockedByFacilitator?: boolean;
  viewLink?: string;
  // Authorship metadata.
  createdBy?: MuralUserRef;
  updatedBy?: MuralUserRef;
  contentEditedBy?: MuralUserRef;
  createdOn?: number;
  updatedOn?: number;
  contentEditedOn?: number;
}

// Specific widget types — discriminated on `type`, carrying their content fields.
export interface StickyNoteWidget extends MuralWidgetBase {
  type: 'sticky note';
  text: string;
  shape?: string;
}

// The API returns plain text widgets with type 'text' (the create endpoint
// uses the 'text-box' kind, but the read response type is 'text').
export interface TextBoxWidget extends MuralWidgetBase {
  type: 'text';
  text: string;
}

export interface TitleWidget extends MuralWidgetBase {
  type: 'title';
  text: string;
}

export interface ShapeWidget extends MuralWidgetBase {
  type: 'shape';
  shape?: string;
  text?: string;
}

export interface ImageWidget extends MuralWidgetBase {
  type: 'image';
  url?: string;
  filename?: string;
}

export interface FileWidget extends MuralWidgetBase {
  type: 'file';
  url?: string;
  filename?: string;
  fileSize?: number;
  mimeType?: string;
}

export interface TableWidget extends MuralWidgetBase {
  type: 'table';
  rows?: number;
  columns?: number;
  data?: unknown[][];
}

export interface AreaWidget extends MuralWidgetBase {
  type: 'area';
}

export interface ArrowWidget extends MuralWidgetBase {
  type: 'arrow';
  points?: { x: number; y: number }[];
  startWidget?: string;
  endWidget?: string;
  arrowType?: string;
}

// Union of all known widget shapes. `MuralWidgetBase` is included last as a
// permissive fallback for widget types not enumerated above.
export type MuralWidget =
  | StickyNoteWidget
  | TextBoxWidget
  | TitleWidget
  | ShapeWidget
  | ImageWidget
  | FileWidget
  | TableWidget
  | AreaWidget
  | ArrowWidget
  | MuralWidgetBase;

// Backwards-compatible alias.
export type AnyMuralWidget = MuralWidget;

// Widget creation requests and responses
export interface CreateWidgetRequest {
  widgets: Partial<AnyMuralWidget>[];
}

// Widget creation helpers
export interface CreateStickyNoteRequest {
  x: number;
  y: number;
  text: string;
  shape: 'rectangle'; // Required field for sticky notes
  width?: number;
  height?: number;
  style?: WidgetTextStyle;
}

// ============================================================================
// UPDATE REQUEST TYPES FOR PATCH OPERATIONS
// ============================================================================

// Widget update request interfaces
export interface UpdateStickyNoteRequest extends Partial<CreateStickyNoteRequest> {
  id?: string; // Widget ID for updates
}
