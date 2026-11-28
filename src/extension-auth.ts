export const extensionSignInPath = '/extension/sign-in';
export const browserAuthMessage = 'wc-browser-auth';
export const browserAuthResult = 'wc-browser-auth-result';
export const challengePattern = /^[0-9a-f]{32}$/;
export type AuthTokens = {access_token:string;refresh_token:string};

export function authTokens(value:unknown):AuthTokens|null {
  if (!value || typeof value!=='object' || !('access_token' in value) || !('refresh_token' in value)) return null;
  const {access_token,refresh_token}=value;
  if (typeof access_token!=='string' || typeof refresh_token!=='string' || !access_token || !refresh_token
      || access_token.length>16384 || refresh_token.length>2048) return null;
  return {access_token,refresh_token};
}

export function handOffSession(state:string,tokens:AuthTokens):Promise<void> {
  return new Promise<void>((resolve,reject)=>{
    function cleanup() {
      window.removeEventListener('message',receive);
      clearTimeout(timer);
    }
    function receive(event:MessageEvent) {
      if (event.source!==window || event.origin!==location.origin
          || event.data?.type!==browserAuthResult || event.data.state!==state) return;
      cleanup();
      if (event.data.ok===true) resolve();
      else reject(new Error('Chrome could not finish signing in. Start again from Web Comments in Chrome.'));
    }
    const timer=setTimeout(()=>{
      cleanup();
      reject(new Error('The extension did not respond. Open a new sign-in tab from Web Comments in Chrome.'));
    },15000);
    window.addEventListener('message',receive);
    window.postMessage({type:browserAuthMessage,state,tokens},location.origin);
  });
}
