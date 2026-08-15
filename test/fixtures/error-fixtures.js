/**
 * Error Fixtures: GraphQL errors, HTTP errors, Rate limits, Auth & Token errors
 */

export const gqlAuthErrorFixture = {
    errors: [
        {
            message: "Must provide valid OAuth token",
            status: 401,
            extensions: {
                code: "UNAUTHENTICATED"
            }
        }
    ]
};

export const gqlForbiddenErrorFixture = {
    errors: [
        {
            message: "Integrity check failed: Client-Integrity required",
            status: 403,
            extensions: {
                code: "FORBIDDEN"
            }
        }
    ]
};

export const gqlRateLimitErrorFixture = {
    errors: [
        {
            message: "Rate limit exceeded. Try again later.",
            status: 429,
            extensions: {
                code: "RATE_LIMITED"
            }
        }
    ]
};

export const gqlInternalServerErrorFixture = {
    errors: [
        {
            message: "Internal server error occurred while processing query.",
            status: 500,
            extensions: {
                code: "INTERNAL_SERVER_ERROR"
            }
        }
    ]
};

export const expiredIntegrityTokenFixture = {
    token: "expired.integ.jwt.token",
    expiration: Date.now() - 60000 // 1 minute ago
};

export const validIntegrityTokenFixture = {
    token: "valid.integ.jwt.token",
    expiration: Date.now() + 3600000 // 1 hour ahead
};

export const malformedJsonString = "{\"data\": {\"currentUser\": { INVALID JSON ";
