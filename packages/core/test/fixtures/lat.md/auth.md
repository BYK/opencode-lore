# Authentication

OAuth2 with PKCE flow for all client authentication.

## Token Lifecycle

Tokens are issued with a 1-hour expiry and refreshed via the token endpoint.

See [[architecture#Request Pipeline]] for how auth fits into the middleware chain.

## Rate Limiting

API rate limits are enforced per-user using a sliding window algorithm.

The window size is 60 seconds with a default limit of 100 requests.
