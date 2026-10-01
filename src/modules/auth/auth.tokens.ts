import { config } from "../../config/env";
import { createAccessTokenSigner } from "../../common/utils/tokens";

// The access-token signer, configured from the environment (JWT_SECRET, JWT_EXPIRES_IN).
export const accessTokens = createAccessTokenSigner(config.jwtSecret, config.accessTokenTtlSeconds);
