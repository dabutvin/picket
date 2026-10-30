import { AuthRequest, CodeChallengeMethod, ResponseType, exchangeCodeAsync, makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import type { ConnectRequest, LightroomStatusView } from './types';

WebBrowser.maybeCompleteAuthSession();

/**
 * Adobe fixes the redirect for Native App credentials to adobe+<hash>://adobeid/<clientId>.
 * The backend tells us the exact value; that scheme is registered in app.json. The
 * picket:// fallback only exists for local experiments.
 */
export const redirectUriFor = (oauth: LightroomStatusView['oauth']): string =>
  oauth.redirectUri || makeRedirectUri({ scheme: 'picket', path: 'oauth' });

export type AdobeLoginResult = { type: 'success'; tokens: ConnectRequest } | { type: 'cancel' } | { type: 'error'; message: string };

/**
 * Authorization Code + PKCE against Adobe IMS. The app only ever holds the tokens
 * long enough to hand them to our backend, which does the uploads.
 */
export async function loginToAdobe(oauth: LightroomStatusView['oauth']): Promise<AdobeLoginResult> {
  if (!oauth.clientId) return { type: 'error', message: 'The server has no Lightroom client id configured.' };

  const redirectUri = redirectUriFor(oauth);
  const request = new AuthRequest({
    clientId: oauth.clientId,
    scopes: oauth.scopes,
    redirectUri,
    responseType: ResponseType.Code,
    usePKCE: true,
    codeChallengeMethod: CodeChallengeMethod.S256,
  });

  const result = await request.promptAsync({ authorizationEndpoint: oauth.authorizeUrl });
  if (result.type === 'cancel' || result.type === 'dismiss') return { type: 'cancel' };
  if (result.type !== 'success') {
    return { type: 'error', message: 'error' in result && result.error ? String(result.error.description ?? result.error.code) : `Login ${result.type}` };
  }
  const code = result.params.code;
  if (!code) return { type: 'error', message: 'Adobe returned no authorization code' };

  const tokens = await exchangeCodeAsync(
    {
      clientId: oauth.clientId,
      code,
      redirectUri,
      scopes: oauth.scopes,
      extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : {},
    },
    { tokenEndpoint: oauth.tokenUrl },
  );
  if (!tokens.refreshToken) {
    return { type: 'error', message: 'Adobe did not return a refresh token. Make sure the credential has the offline_access scope.' };
  }
  return {
    type: 'success',
    tokens: { refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresIn: tokens.expiresIn },
  };
}
