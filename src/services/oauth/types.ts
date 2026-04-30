export type SubscriptionType =
  | 'max'
  | 'pro'
  | 'team'
  | 'enterprise'

export type RateLimitTier = string

export type BillingType = string

export type OAuthProfileResponse = {
  account: {
    uuid?: string
    email_address?: string
    display_name?: string
    created_at?: string
  }
  organization?: {
    uuid?: string
    organization_type?: string
    rate_limit_tier?: string
    has_extra_usage_enabled?: boolean
    billing_type?: string
    subscription_created_at?: string
  }
}

export type OAuthTokenExchangeResponse = {
  access_token: string
  refresh_token: string | null
  expires_in: number
  scope: string
  account?: {
    uuid: string
    email_address?: string
  }
  organization?: {
    uuid?: string
  }
}

export type OAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[] | null
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  profile?: OAuthProfileResponse
  tokenAccount?: {
    uuid: string
    emailAddress?: string
    organizationUuid?: string
  }
}

export type UserRolesResponse = {
  account: {
    uuid: string
    email_address?: string
  }
  organization?: {
    uuid?: string
  }
  [key: string]: unknown
}
